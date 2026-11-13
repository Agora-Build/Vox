import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BrowserCaptures } from "../server/browser-capture";
import type { BrowserGrant } from "../server/browser-viewers";
import type { BrowserCommand, BrowserFrame, BrowserOperation, BrowserResponse } from "../shared/browser-assistance";

const target = { key: "target", kind: "agent" as const, agentId: 1, leaseId: "agent-lease", generation: "connection", jobId: 1, startedAt: "start" };
const a: BrowserGrant = { id: randomUUID(), userId: 1, jobId: 1, target };
const b: BrowserGrant = { ...a, id: randomUUID(), userId: 2 };
const identity = { lease_id: "engine-lease", page_id: "page", document_epoch: 1 };
const frame: BrowserFrame = { version: 1, type: "event", event: "viewer.frame", session_id: "session", browser_generation: "browser",
  ...identity, data: "aW1hZ2U=", metadata: { deviceWidth: 800, deviceHeight: 600 } };
let grants: BrowserGrant[], captures: BrowserCaptures, controlling: boolean, serial: number, waitId: string;
let send: ReturnType<typeof vi.fn>;
const make = (command: BrowserCommand["command"], params?: Record<string, unknown>): BrowserCommand => ({
  version: 1, id: randomUUID(), command, session_id: "session", browser_generation: "browser", params,
});
const run = async (grant: BrowserGrant, command: BrowserCommand["command"], params?: Record<string, unknown>) =>
  captures.handle({ targetKey: target.key, viewerId: grant.id, action: "command", request: make(command, params) }) as Promise<BrowserResponse>;
const open = (grant: BrowserGrant) => run(grant, "viewer.open", identity);
const take = (grant: BrowserGrant) => run(grant, "viewer.take_control", { ...identity, wait_id: waitId });
const input = (grant: BrowserGrant, controlId: unknown) => run(grant, "viewer.input", { ...identity, control_id: controlId, sequence: 1, input: { type: "text", text: "once" } });
const operations = (action: string) => send.mock.calls.map((call) => call[1] as BrowserOperation).filter((op) => op.action === action);
const commands = (name: string) => operations("command").filter((op) => op.request?.command === name);

beforeEach(() => {
  grants = [a, b]; controlling = false; serial = 0; waitId = "wait";
  send = vi.fn(async (_target, op: BrowserOperation) => {
    if (op.action === "close") { controlling = false; return { closed: true }; }
    if (op.action === "frame") return frame;
    const command = op.request!;
    let result: Record<string, unknown> = {};
    if (command.command === "viewer.open") result = { ...identity, mode: "read_only" };
    if (command.command === "viewer.take_control") { controlling = true; result = { control_id: `control-${++serial}`, next_sequence: 1 }; }
    if (command.command === "viewer.release_control") controlling = false;
    if (command.command === "viewer.input") result = { next_sequence: 2 };
    if (command.command === "session.status") result = { session_id: "session", browser_generation: "browser", capabilities: [], viewing: true, controlling,
      pages: [{ page_id: "page", document_epoch: 1, origin: null }], next_sequence: 1,
      assistance: { wait_id: waitId, kind: "authentication", state: controlling ? "held" : "waiting", page_id: "page", remaining_seconds: 30 } };
    return { version: 1, type: "response", id: command.id, ok: true, result };
  });
  captures = new BrowserCaptures(async () => grants, send);
});

describe("owner-Core shared capture", () => {
  it("opens one upstream viewer and fans the same frame out without consuming it per viewer", async () => {
    const [first, second] = await Promise.all([open(a), open(b)]);
    expect(first.viewer).toMatchObject({ count: 2, controller: null }); expect(second.result?.lease_id).toBe(first.result?.lease_id);
    expect(commands("viewer.open")).toHaveLength(1);
    const results = await Promise.all([a, b].map((grant) => captures.handle({ targetKey: target.key, viewerId: grant.id, action: "frame" })));
    expect(results).toEqual([frame, frame]); expect(operations("frame")).toHaveLength(1);
    expect(new Set(operations("command").map((op) => op.viewerId)).size).toBe(1);
    expect(operations("command")[0].viewerId).not.toBe(a.id);
  });

  it("admits one explicit controller even when acquisition races and rejects all spectator mutations", async () => {
    await Promise.all([open(a), open(b)]);
    const results = await Promise.all([take(a), take(b)]);
    expect(results.map((result) => result.ok)).toEqual([true, false]); expect(results[1].error).toBe("CONTROL_BUSY");
    expect(commands("viewer.take_control")).toHaveLength(1);
    for (const command of ["viewer.input", "viewer.open_url", "viewer.select_page", "viewer.release_control", "assistance.continue", "assistance.cancel"] as const) {
      const response = await run(b, command, { ...identity, control_id: results[0].result?.control_id });
      expect(response).toMatchObject({ ok: false, error: "CONTROL_REQUIRED" });
      expect(commands(command)).toHaveLength(0);
    }
    expect((await run(a, "session.status")).result?.controlling).toBe(true);
    const spectator = await run(b, "session.status");
    expect(spectator.result?.controlling).toBe(false); expect(spectator.viewer?.controller).toBe("other");
  });

  it("releases control without closing capture; stale tokens cannot act at a subsequent wait", async () => {
    await open(a); await open(b);
    const first = await take(a);
    expect((await run(a, "viewer.release_control", { ...identity, control_id: first.result?.control_id })).ok).toBe(true);
    expect(commands("viewer.release_control")[0].request?.params?.wait_id).toBe("wait");
    waitId = "subsequent-wait";
    const second = await take(b); expect(second.ok).toBe(true);
    expect((await input(a, first.result?.control_id)).ok).toBe(false);
    expect((await input(b, first.result?.control_id)).error).toBe("STALE_CONTROL");
    expect((await input(b, second.result?.control_id)).ok).toBe(true);
    expect(operations("close")).toHaveLength(0);
  });

  it("closing a spectator does not disrupt the controller; closing the last viewer closes upstream once", async () => {
    await open(a); await open(b); await take(a);
    grants = [a]; await captures.handle({ targetKey: target.key, viewerId: b.id, action: "leave" });
    expect(operations("close")).toHaveLength(0); expect(commands("viewer.release_control")).toHaveLength(0);
    expect((await run(a, "session.status")).viewer).toMatchObject({ count: 1, controller: "you" });
    grants = []; await captures.maintain(); await captures.maintain();
    expect(operations("close")).toHaveLength(1);
  });

  it("controller expiry or revocation releases control while spectators keep their capture", async () => {
    await open(a); await open(b); await take(a);
    grants = [b]; await captures.maintain();
    expect(commands("viewer.release_control")).toHaveLength(1); expect(operations("close")).toHaveLength(0);
    expect((await run(b, "session.status")).viewer?.controller).toBeNull();
    expect((await take(b)).ok).toBe(true);
    await expect(input(a, "old")).rejects.toThrow(/expired|authorization/);
  });

  it("keeps spectators alive if the native hold ended before the controller expired", async () => {
    await open(a); await take(a);
    controlling = false; grants = [b]; await captures.maintain();
    expect(commands("viewer.release_control")).toHaveLength(0);
    expect(operations("close")).toHaveLength(0);
    expect((await run(b, "session.status")).viewer?.controller).toBeNull();
  });

  it("scopes receipts to the issuer and rejects duplicate mutations without replaying them", async () => {
    await open(a); await open(b); const control = await take(a);
    const request = make("viewer.input", { ...identity, control_id: control.result?.control_id, sequence: 1, input: {} });
    const invoke = () => captures.handle({ targetKey: target.key, viewerId: a.id, action: "command", request });
    expect(await invoke()).toMatchObject({ ok: true });
    expect(await invoke()).toMatchObject({ ok: false, error: "COMMAND_ALREADY_SUBMITTED" });
    expect(commands("viewer.input")).toHaveLength(1);
    expect((await run(b, "command.status", { lease_id: "engine-lease", command_id: request.id })).error).toBe("UNKNOWN_COMMAND");
    expect((await run(a, "command.status", { lease_id: "engine-lease", command_id: request.id })).ok).toBe(true);
    expect(commands("command.status")[0].request?.params?.command_id).toBe(commands("viewer.input")[0].request?.id);
    expect(commands("viewer.input")[0].request?.id).not.toBe(request.id);
  });

  it("does not retry an uncertain mutation or silently retain engine control", async () => {
    await open(a); const control = await take(a);
    send.mockImplementationOnce(async () => { throw new Error("transport lost"); });
    await expect(input(a, control.result?.control_id)).rejects.toThrow("transport lost");
    expect(operations("close")).toHaveLength(1);
    expect((await input(a, control.result?.control_id)).error).toBe("VIEWER_NOT_OPEN");
    expect(commands("viewer.input")).toHaveLength(1);
  });

  it("fails closed and closes capture when control release cannot be confirmed", async () => {
    await open(a); await take(a); grants = [b];
    send.mockImplementationOnce(async () => { throw new Error("release failed"); });
    await captures.maintain(); expect(operations("close")).toHaveLength(1);
    expect((await run(b, "viewer.heartbeat", identity)).error).toBe("VIEWER_NOT_OPEN");
  });

  it("keeps heartbeats responsive during slow input without renewing another viewer's grant", async () => {
    await open(a); await open(b); const control = await take(a);
    let resume!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const normal = send.getMockImplementation()!;
    send.mockImplementation(async (target, op) => {
      if (op.request?.command === "viewer.input") { entered(); await blocked; }
      return normal(target, op);
    });
    const mutation = input(a, control.result?.control_id);
    await pending;
    try {
      expect((await run(a, "viewer.heartbeat", identity)).ok).toBe(true);
      expect((await run(b, "viewer.heartbeat", identity)).ok).toBe(true);
      expect(commands("viewer.heartbeat")).toHaveLength(1);
      grants = [b];
      await expect(run(a, "viewer.heartbeat", identity)).rejects.toThrow(/expired|authorization/);
      expect((await run(b, "viewer.heartbeat", identity)).ok).toBe(true);
    } finally { resume(); await mutation; }
  });
});
