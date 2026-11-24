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
  it("forwards active and final v0.4.5 readiness outcomes without changing controller authority", async () => {
    await open(a); await take(a);
    const reason = { wait_id: waitId, kind: "authentication", state: "checking", reason: "selector_absent", last_check_reason: "selector_absent", page_id: "page", remaining_seconds: 20 };
    send.mockImplementationOnce(async (_target, operation: BrowserOperation) => ({
      version: 1, type: "response", id: operation.request!.id, ok: true,
      result: { session_id: "session", browser_generation: "browser", capabilities: [], viewing: true, controlling: true,
        pages: [{ page_id: "page", document_epoch: 1, origin: null }], next_sequence: 1,
        assistance: reason, last_assistance: { ...reason, state: "expired", reason: "assistance_expired" } },
    }));
    const response = await run(b, "session.status");
    expect(response.result?.assistance).toEqual(reason);
    expect(response.result?.last_assistance).toMatchObject({ state: "expired", reason: "assistance_expired" });
    expect(response.result?.controlling).toBe(false);
    expect(response.viewer?.controller).toBe("other");
  });

  it("sanitizes readiness metadata before returning status to the viewer", async () => {
    await open(a);
    const wait = { wait_id: waitId, kind: "authentication", state: "checking", page_id: "page", remaining_seconds: 20 };
    send.mockImplementationOnce(async (_target, operation: BrowserOperation) => ({
      version: 1, type: "response", id: operation.request!.id, ok: true,
      result: { session_id: "session", browser_generation: "browser", capabilities: [], viewing: true, controlling: false,
        pages: [{ page_id: "page", document_epoch: 1, origin: null }], next_sequence: 1,
        assistance: { ...wait, reason: "https://provider.example/verify?token=secret-token", last_check_reason: "password=secret-password" },
        last_assistance: { ...wait, state: "future_state" }, debug: "secret-debug" },
    }));
    const response = await run(a, "session.status");
    expect(response.result?.assistance).toMatchObject({ reason: null, last_check_reason: null });
    expect(response.result?.last_assistance).toBeNull();
    expect(response.result).not.toHaveProperty("debug");
    expect(JSON.stringify(response)).not.toContain("secret-");
  });

  it("opens one upstream viewer and fans the same frame out without consuming it per viewer", async () => {
    const [first, second] = await Promise.all([open(a), open(b)]);
    expect(first.viewer).toMatchObject({ count: 2, controller: null }); expect(second.result?.lease_id).toBe(first.result?.lease_id);
    expect(commands("viewer.open")).toHaveLength(1);
    const results = await Promise.all([a, b].map((grant) => captures.handle({ targetKey: target.key, viewerId: grant.id, action: "frame" })));
    expect(results).toEqual([frame, frame]); expect(operations("frame")).toHaveLength(1);
    expect(new Set(operations("command").map((op) => op.viewerId)).size).toBe(1);
    expect(operations("command")[0].viewerId).not.toBe(a.id);
  });

  it("rechecks authority for cached pixels without reconciling every controller on every frame poll", async () => {
    let allowed = true;
    const authorize = vi.fn(async () => allowed);
    captures = new BrowserCaptures(async () => grants, send, authorize);
    await open(a); await take(a);
    const read = () => captures.handle({ targetKey: target.key, viewerId: a.id, action: "frame" });
    expect(await read()).toEqual(frame);
    authorize.mockClear();
    expect(await read()).toEqual(frame);
    expect(authorize).toHaveBeenCalledTimes(1);
    allowed = false;
    await expect(read()).rejects.toThrow(/authorization/);
    expect(operations("frame")).toHaveLength(1);
  });

  it.each(["authorization", "expiry"])("discards slow frames when %s changes during capture", async (change) => {
    let allowed = true;
    captures = new BrowserCaptures(async () => grants, send, async () => allowed);
    await open(a);
    let resume!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    send.mockImplementationOnce(async () => { entered(); await blocked; return frame; });
    const read = captures.handle({ targetKey: target.key, viewerId: a.id, action: "frame" });
    await pending;
    if (change === "authorization") allowed = false;
    else grants = [b];
    const rejected = expect(read).rejects.toThrow(/expired|authorization/);
    resume();
    await rejected;
    expect(operations("frame")).toHaveLength(1);
  });

  it("admits one explicit controller even when acquisition races and rejects all spectator mutations", async () => {
    await Promise.all([open(a), open(b)]);
    const results = await Promise.all([take(a), take(b)]);
    expect(results.map((result) => result.ok)).toEqual([true, false]); expect(results[1].error).toBe("CONTROL_BUSY");
    expect(commands("viewer.take_control")).toHaveLength(1);
    for (const command of ["viewer.input", "viewer.open_url", "viewer.select_page", "viewer.release_control", "assistance.continue", "authentication.continue", "authentication.open_verification", "authentication.continue_flow", "assistance.cancel"] as const) {
      const response = await run(b, command, { ...identity, control_id: results[0].result?.control_id });
      expect(response).toMatchObject({ ok: false, error: "CONTROL_REQUIRED" });
      expect(commands(command)).toHaveLength(0);
    }
    expect((await run(a, "session.status")).result?.controlling).toBe(true);
    const spectator = await run(b, "session.status");
    expect(spectator.result?.controlling).toBe(false); expect(spectator.viewer?.controller).toBe("other");
  });

  it("binds verification to the controlled wait and follows the engine back to the evaluation tab", async () => {
    await open(a); await open(b);
    const control = await take(a);
    const params = { ...identity, wait_id: waitId, control_id: control.result?.control_id, sequence: 1, url: "https://provider.example/verification" };
    expect((await run(a, "authentication.open_verification", { ...params, wait_id: "old-wait" })).error).toBe("STALE_CONTROL");
    send.mockImplementationOnce(async (_target, op: BrowserOperation) => {
      controlling = false;
      return { version: 1, type: "response", id: op.request!.id, ok: true,
        result: { page_id: "verification", document_epoch: 2, next_sequence: 2 } };
    });
    const opened = await run(a, "authentication.open_verification", params);
    expect(opened.viewer).toMatchObject({ page_id: "verification", document_epoch: 2, controller: null });
    const selected = { ...identity, page_id: "verification", document_epoch: 2, wait_id: waitId };
    expect((await run(a, "viewer.take_control", selected)).ok).toBe(true);
    send.mockImplementationOnce(async (_target, op: BrowserOperation) => {
      controlling = false;
      return { version: 1, type: "response", id: op.request!.id, ok: true, result: { checking: true } };
    });
    expect(await run(a, "authentication.continue_flow", selected)).toMatchObject({ ok: true, viewer: { controller: null } });
    expect((await take(b)).error).toBe("CONTROL_BUSY");
    send.mockImplementationOnce(async (_target, op: BrowserOperation) => ({ version: 1, type: "response", id: op.request!.id, ok: true,
      result: { session_id: "session", browser_generation: "browser", capabilities: ["auth.verification-flow.v1"],
        viewing: true, controlling: false, next_sequence: 2, assistance: null, selected_page_id: "page",
        pages: [{ page_id: "page", document_epoch: 3, origin: null }, { page_id: "verification", document_epoch: 2, origin: null }] },
    }));
    expect((await run(b, "session.status")).viewer).toMatchObject({ page_id: "page", document_epoch: 3 });
    expect((await take(b)).ok).toBe(true);
    expect(commands("authentication.continue_flow")).toHaveLength(1);
  });

  it("sends only the unwrapped verification destination to the engine", async () => {
    await open(a);
    const control = await take(a);
    const params = { ...identity, wait_id: waitId, control_id: control.result?.control_id, sequence: 1 };
    const providerUrl = "https://provider.example/verify?code=fixture%2Bvalue";
    const checkpoint = `https://protect.checkpoint.com/v2/r01/___${providerUrl}___.fixture_signature`;
    const wrapped = `https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(checkpoint)}`;

    const invalid = await run(a, "authentication.open_verification", { ...params, url: `${wrapped}&url=${encodeURIComponent(providerUrl)}` });
    expect(invalid.error).toBe("INVALID_VERIFICATION_LINK");
    expect(commands("authentication.open_verification")).toHaveLength(0);

    const opened = await run(a, "authentication.open_verification", { ...params, url: wrapped });
    expect(opened.ok).toBe(true);
    expect(commands("authentication.open_verification")).toHaveLength(1);
    expect(commands("authentication.open_verification")[0].request?.params).toEqual({ ...params, url: providerUrl });
  });

  it("resolves unfamiliar wrappers against the active sign-in page's origin", async () => {
    await open(a);
    const control = await take(a);
    const params = { ...identity, wait_id: waitId, control_id: control.result?.control_id, sequence: 1 };
    const origin = "https://provider.example";
    const targetUrl = `${origin}/verify?code=fixture%2Bvalue`;
    const wrapper = (url: string) => `https://mail-security.example/redirect?destination=${encodeURIComponent(url)}`;
    const status = (activeWait: string) => send.mockImplementationOnce(async (_target, op: BrowserOperation) => ({
      version: 1, type: "response", id: op.request!.id, ok: true,
      result: { session_id: "session", browser_generation: "browser", capabilities: ["auth.verification-flow.v1"],
        pages: [{ page_id: "page", document_epoch: 1, origin }], viewing: true, controlling: true, next_sequence: 1,
        assistance: { wait_id: activeWait, kind: "authentication", state: "held", page_id: "page", remaining_seconds: 30,
          authentication: { verification_flow: true } } },
    }));

    status("new-wait");
    expect((await run(a, "authentication.open_verification", { ...params, url: wrapper(targetUrl) })).error).toBe("STALE_CONTROL");
    status(waitId);
    expect((await run(a, "authentication.open_verification", { ...params, url: wrapper("https://other.example/verify") })).error)
      .toBe("INVALID_VERIFICATION_LINK");
    expect(commands("authentication.open_verification")).toHaveLength(0);

    status(waitId);
    expect((await run(a, "authentication.open_verification", { ...params, url: wrapper(targetUrl) })).ok).toBe(true);
    expect(commands("authentication.open_verification")).toHaveLength(1);
    expect(commands("authentication.open_verification")[0].request?.params).toEqual({ ...params, url: targetUrl });
  });

  it("stops the engine sign-in when the authorizing viewer leaves while a spectator remains", async () => {
    await open(a); await open(b); await take(a);
    send.mockImplementationOnce(async (_target, op: BrowserOperation) => ({
      version: 1, type: "response", id: op.request!.id, ok: true, result: { checking: true },
    }));
    await run(a, "authentication.continue_flow", { ...identity, wait_id: waitId });
    grants = [a];
    await captures.handle({ targetKey: target.key, viewerId: b.id, action: "leave" });
    expect(operations("close")).toHaveLength(0);
    grants = [b];
    await captures.handle({ targetKey: target.key, viewerId: a.id, action: "leave" });
    expect(operations("close")).toHaveLength(1);
    expect((await open(b)).ok).toBe(true);
  });

  it("closes the engine viewer when a sign-in acknowledgement is ambiguous", async () => {
    await open(a); await take(a);
    const response = await run(a, "authentication.continue_flow", { ...identity, wait_id: waitId });
    expect(response).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
    expect(commands("authentication.continue_flow")).toHaveLength(1);
    expect(operations("close")).toHaveLength(1);
  });

  it("protects a controlled manual tab from other viewers and revokes input without a wait ID", async () => {
    await open(a); await open(b);
    send.mockImplementationOnce(async (_target, op: BrowserOperation) => ({ version: 1, type: "response", id: op.request!.id, ok: true,
      result: { page_id: "manual", document_epoch: 2, next_sequence: 2 },
    }));
    await run(a, "viewer.open_tab", { ...identity, sequence: 1, url: "https://provider.example/extra" });
    const manual = { ...identity, page_id: "manual", document_epoch: 2 };
    expect((await run(a, "viewer.take_control", manual)).ok).toBe(true);
    expect((await run(b, "viewer.close_tab", { ...manual, target_page_id: "manual", target_document_epoch: 2 })).error).toBe("CONTROL_BUSY");
    expect((await run(a, "viewer.close_tab", { ...manual, target_page_id: "page", target_document_epoch: 1 })).error).toBe("STALE_PAGE");
    expect((await run(a, "authentication.continue_flow", { ...manual, wait_id: waitId })).error).toBe("STALE_CONTROL");
    grants = [b];
    await captures.handle({ targetKey: target.key, viewerId: a.id, action: "leave" });
    expect(commands("viewer.release_control")[0].request?.params).toMatchObject({ ...manual, control_id: "control-1", wait_id: null });
    expect(commands("viewer.close_tab")).toHaveLength(0);
    expect(operations("close")).toHaveLength(0);
  });

  it("forwards stage-bound credential consent once, clears control, and never grants it on release", async () => {
    await open(a); await open(b); await take(a);
    const params = { ...identity, wait_id: waitId, stage_id: "password", stage_token: "opaque-stage" };
    const request = make("authentication.continue", params);
    const invoke = () => captures.handle({ targetKey: target.key, viewerId: a.id, action: "command", request });
    expect(await invoke()).toMatchObject({ ok: true, viewer: { controller: null } });
    expect(commands("authentication.continue")[0].request).toMatchObject({
      session_id: "session", browser_generation: "browser", params,
    });
    expect(await invoke()).toMatchObject({ ok: false, error: "CONTROL_REQUIRED" });
    expect(commands("authentication.continue")).toHaveLength(1);
    await take(a);
    expect(await invoke()).toMatchObject({ ok: false, error: "COMMAND_ALREADY_SUBMITTED" });
    await run(a, "viewer.release_control", { ...identity, control_id: "control-2" });
    expect(commands("authentication.continue")).toHaveLength(1);
  });

  it("does not retry an uncertain credential continuation", async () => {
    await open(a); await take(a);
    send.mockImplementationOnce(async () => { throw new Error("transport lost"); });
    await expect(run(a, "authentication.continue", { ...identity, wait_id: waitId, stage_id: "password", stage_token: "opaque" })).rejects.toThrow("transport lost");
    expect(commands("authentication.continue")).toHaveLength(1);
    expect(operations("close")).toHaveLength(1);
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
