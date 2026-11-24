import { randomUUID } from "node:crypto";
import { browserFrameSchema, browserStatusSchema, MANUAL_TABS_CAPABILITY, type BrowserCommand, type BrowserFrame,
  type BrowserOperation, type BrowserResponse, type BrowserViewerState } from "@shared/browser-assistance";
import type { BrowserGrant, BrowserTarget } from "./browser-viewers";

type Send = (target: BrowserTarget, operation: BrowserOperation) => Promise<unknown>;
type Capture = {
  target: BrowserTarget; upstreamId: string; leaseId: string; sessionId: string; generation: string;
  pageId: string; epoch: number; controller: string | null; controlId: string | null; waitId: string | null;
  frame: BrowserFrame | null; frameAt: number; failed: boolean; revision: number;
  heartbeatAt: number; heartbeat: Promise<BrowserResponse> | null; heartbeatDone: boolean;
  receipts: Map<string, { viewerId: string; upstreamId: string }>;
  signIn: { viewerId: string; waitId: string } | null;
  manualTabs: boolean;
};
export type CaptureRequest = { targetKey: string; viewerId: string; action: "command" | "frame" | "leave"; request?: BrowserCommand };
const navigation = ["viewer.open_url", "viewer.select_page", "authentication.open_verification", "viewer.open_tab", "viewer.close_tab"];
const releasesControl = [...navigation, "viewer.release_control", "assistance.continue", "authentication.continue", "authentication.continue_flow", "assistance.cancel"];
const mutations = new Set([...releasesControl, "viewer.input"]);

/** One owner-Core arbiter and one engine capture per fenced browser target. */
export class BrowserCaptures {
  private captures = new Map<string, Capture>();
  private queues = new Map<string, { tail: Promise<unknown>; size: number }>();
  constructor(private active: (key: string) => Promise<BrowserGrant[]>, private send: Send,
    private authorized: (grant: BrowserGrant) => Promise<boolean> = async () => true) {}

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= 24) throw new Error("Shared browser is busy; input will not be replayed");
    queue.size++; this.queues.set(key, queue);
    const next = queue.tail.catch(() => undefined).then(work);
    queue.tail = next;
    try { return await next; }
    finally { if (--queue.size === 0) this.queues.delete(key); }
  }
  private identity(capture: Capture): Record<string, unknown> {
    return { lease_id: capture.leaseId, page_id: capture.pageId, document_epoch: capture.epoch };
  }
  private state(capture: Capture, id: string, count: number): BrowserViewerState {
    return { count, revision: capture.revision, controller: !capture.controller ? null : capture.controller === id ? "you" : "other",
      lease_id: capture.leaseId, page_id: capture.pageId, document_epoch: capture.epoch };
  }
  private async engine(capture: Capture, command: BrowserCommand): Promise<BrowserResponse> {
    return await this.send(capture.target, { action: "command", viewerId: capture.upstreamId, request: command }) as BrowserResponse;
  }
  private internal(capture: Capture, command: BrowserCommand["command"], params?: Record<string, unknown>): BrowserCommand {
    return { version: 1, id: randomUUID(), command, session_id: capture.sessionId,
      browser_generation: capture.generation, params };
  }
  private async close(capture: Capture): Promise<void> {
    if (this.captures.get(capture.target.key) === capture) this.captures.delete(capture.target.key);
    capture.failed = true; capture.frame = null; capture.controller = null; capture.controlId = null; capture.waitId = null;
    await this.send(capture.target, { action: "close", viewerId: capture.upstreamId }).catch(() => undefined);
  }
  private async release(capture: Capture): Promise<void> {
    if (!capture.controller) return;
    const controlId = capture.controlId;
    const waitId = capture.waitId;
    capture.controller = null; capture.controlId = null; capture.waitId = null; capture.revision++;
    try {
      const current = await this.engine(capture, this.internal(capture, "session.status"));
      if (!current.ok) throw new Error("Control state could not be confirmed");
      const status = browserStatusSchema.parse(current.result);
      // The engine may already have released input after navigation or a deadline.
      if (!status.controlling || (waitId !== null && status.assistance?.wait_id !== waitId)) return;
      const response = await this.engine(capture, this.internal(capture, "viewer.release_control", {
        ...this.identity(capture), control_id: controlId, wait_id: waitId,
      }));
      if (!response.ok) {
        const after = await this.engine(capture, this.internal(capture, "session.status"));
        if (after.ok && !browserStatusSchema.parse(after.result).controlling) return;
        throw new Error("Control release was not confirmed");
      }
    } catch (error) { capture.failed = true; capture.frame = null; throw error; }
  }
  private async reconcile(capture: Capture, grants: BrowserGrant[]): Promise<void> {
    if (!grants.length) { await this.close(capture); return; }
    const signIn = capture.signIn;
    if (signIn) {
      const initiator = grants.find((grant) => grant.id === signIn.viewerId);
      // The engine sees one socket for all viewers. End it if the user who authorized sign-in leaves.
      if (!initiator || !await this.authorized(initiator)) { await this.close(capture); return; }
    }
    const controller = grants.find((grant) => grant.id === capture.controller);
    if (capture.controller && (!controller || !await this.authorized(controller))) await this.release(capture);
  }
  async maintain(): Promise<void> {
    await Promise.allSettled(Array.from(this.captures.values(), (capture) => this.serial(capture.target.key, async () => {
      try {
        const active = await this.active(capture.target.key);
        const authorized = await Promise.all(active.map((grant) => this.authorized(grant)));
        await this.reconcile(capture, active.filter((_grant, index) => authorized[index]));
      }
      catch { await this.close(capture); }
    })));
  }
  private async heartbeat(input: CaptureRequest): Promise<BrowserResponse> {
    const command = input.request!;
    const grants = await this.active(input.targetKey);
    const grant = grants.find((item) => item.id === input.viewerId);
    if (!grant || !await this.authorized(grant)) throw new Error("Viewer expired or authorization changed");
    const capture = this.captures.get(input.targetKey);
    const denied = (error: string): BrowserResponse => ({ version: 1, type: "response", id: command.id, ok: false, error });
    if (!capture || capture.failed) return denied("VIEWER_NOT_OPEN");
    if (command.session_id !== capture.sessionId || command.browser_generation !== capture.generation
      || command.params?.lease_id !== capture.leaseId) return denied("STALE_BROWSER");
    // Liveness must not queue behind slow navigation/input. Coalesce spectators'
    // heartbeats, but only the requesting grant's HTTP response renews its grant.
    if (!capture.heartbeat || (capture.heartbeatDone && Date.now() - capture.heartbeatAt >= 500)) {
      capture.heartbeatAt = Date.now();
      capture.heartbeatDone = false;
      const pending = this.engine(capture, this.internal(capture, "viewer.heartbeat", { lease_id: capture.leaseId }));
      capture.heartbeat = pending;
      void pending.then(() => { if (capture.heartbeat === pending) capture.heartbeatDone = true; },
        () => { if (capture.heartbeat === pending) capture.heartbeat = null; });
    }
    const response = await capture.heartbeat;
    if (capture.failed || this.captures.get(input.targetKey) !== capture) return denied("VIEWER_NOT_OPEN");
    return { ...response, id: command.id, viewer: this.state(capture, grant.id, grants.length) };
  }
  async handle(input: CaptureRequest): Promise<unknown> {
    if (input.action === "command" && input.request?.command === "viewer.heartbeat") return this.heartbeat(input);
    return this.serial(input.targetKey, async () => {
      const grants = await this.active(input.targetKey);
      let capture = this.captures.get(input.targetKey);
      if (capture && input.action !== "frame") await this.reconcile(capture, grants);
      if (input.action === "leave") return { closed: true };
      const grant = grants.find((item) => item.id === input.viewerId);
      if (!grant || !await this.authorized(grant)) throw new Error("Viewer expired or authorization changed; reopen the viewer");
      if (capture?.failed) throw new Error("Capture outcome unknown; close and reopen the viewer");
      if (input.action === "frame") {
        if (!capture) return null;
        if (Date.now() - capture.frameAt >= 180) {
          const result = browserFrameSchema.safeParse(await this.send(capture.target, { action: "frame", viewerId: capture.upstreamId }));
          // Recheck after slow capture, but never cache authorization with the shared frame.
          const current = (await this.active(input.targetKey)).find((item) => item.id === grant.id);
          if (!current || !await this.authorized(current)) throw new Error("Viewer expired or authorization changed");
          capture.frameAt = Date.now();
          if (result.success) {
            const frame = result.data;
            if (frame.lease_id === capture.leaseId && frame.session_id === capture.sessionId && frame.browser_generation === capture.generation
              && frame.page_id === capture.pageId && frame.document_epoch >= capture.epoch) {
              if (capture.epoch !== frame.document_epoch) capture.revision++;
              capture.epoch = frame.document_epoch; capture.frame = frame;
            }
          }
        }
        return capture.frame;
      }
      const command = input.request;
      if (!command) throw new Error("Browser command required");
      const denied = (error: string): BrowserResponse => ({ version: 1, type: "response", id: command.id, ok: false, error });
      if (command.command === "viewer.close") return denied("USE_DELETE_VIEWER");
      if (!capture) {
        if (command.command !== "viewer.open") return denied("VIEWER_NOT_OPEN");
        const candidate: Capture = { target: grant.target, upstreamId: randomUUID(), leaseId: "", sessionId: command.session_id ?? "",
          generation: command.browser_generation ?? "", pageId: "", epoch: 0, controller: null, controlId: null, waitId: null, signIn: null, manualTabs: false,
          frame: null, frameAt: 0, failed: false, revision: 1, heartbeatAt: 0, heartbeat: null, heartbeatDone: false, receipts: new Map() };
        try {
          const response = await this.engine(candidate, { ...command, id: randomUUID() });
          if (!response.ok || typeof response.result?.lease_id !== "string") { await this.close(candidate); return { ...response, id: command.id }; }
          candidate.leaseId = response.result.lease_id;
          candidate.pageId = String(response.result.page_id ?? command.params?.page_id ?? "");
          candidate.epoch = Number(response.result.document_epoch ?? command.params?.document_epoch ?? 0);
          capture = candidate; this.captures.set(input.targetKey, capture);
          return { ...response, id: command.id, viewer: this.state(capture, grant.id, grants.length) };
        } catch (error) { await this.close(candidate); throw error; }
      }
      if (command.session_id !== capture.sessionId || command.browser_generation !== capture.generation) return denied("STALE_BROWSER");
      if (command.command === "viewer.open") return { version: 1, type: "response", id: command.id, ok: true,
        result: { lease_id: capture.leaseId, page_id: capture.pageId, document_epoch: capture.epoch, mode: "read_only" },
        viewer: this.state(capture, grant.id, grants.length) };
      if (command.command === "viewer.take_control" && (capture.controller || capture.signIn)) return denied("CONTROL_BUSY");
      const tabManagement = command.command === "viewer.open_tab" || command.command === "viewer.close_tab";
      const canNavigateWithoutControl = tabManagement || (command.command === "viewer.select_page" && capture.manualTabs);
      if (canNavigateWithoutControl && (capture.signIn || (capture.controller && capture.controller !== grant.id))) return denied("CONTROL_BUSY");
      if (mutations.has(command.command) && !canNavigateWithoutControl && capture.controller !== grant.id) return denied("CONTROL_REQUIRED");
      if (command.command === "viewer.close_tab" && command.params?.target_page_id !== capture.pageId) return denied("STALE_PAGE");
      if (["viewer.input", "viewer.open_url", "viewer.release_control", "authentication.open_verification"].includes(command.command)
        && command.params?.control_id !== capture.controlId) return denied("STALE_CONTROL");
      if ((command.command === "authentication.open_verification" || command.command === "authentication.continue_flow")
        && (!capture.waitId || command.params?.wait_id !== capture.waitId)) return denied("STALE_CONTROL");
      const upstreamId = randomUUID();
      const request = { ...command, id: upstreamId };
      if (command.command === "viewer.release_control") request.params = { ...command.params, wait_id: capture.waitId };
      if (command.command === "command.status") {
        const receipt = capture.receipts.get(String(command.params?.command_id));
        if (receipt?.viewerId !== grant.id) return denied("UNKNOWN_COMMAND");
        request.params = { ...command.params, command_id: receipt.upstreamId };
      } else if (command.command !== "session.status" && command.command !== "viewer.heartbeat") {
        if (capture.receipts.size >= 128) capture.receipts.delete(capture.receipts.keys().next().value!);
        // IDs and receipts are scoped to the issuing grant, never replayed on timeout.
        if (capture.receipts.has(command.id)) return denied("COMMAND_ALREADY_SUBMITTED");
        capture.receipts.set(command.id, { viewerId: grant.id, upstreamId });
      }
      let response: BrowserResponse;
      try { response = await this.engine(capture, request); }
      catch (error) {
        if (mutations.has(command.command) || command.command === "viewer.take_control") { capture.failed = true; await this.close(capture); }
        throw error;
      }
      if (command.command === "authentication.continue_flow"
        && (response.error === "OUTCOME_UNKNOWN" || (response.ok && response.result?.checking !== true))) {
        await this.close(capture);
        return denied("OUTCOME_UNKNOWN");
      }
      if (response.ok) {
        if (command.command === "viewer.take_control") {
          if (typeof response.result?.control_id !== "string") { await this.close(capture); throw new Error("Invalid control grant"); }
          capture.controller = grant.id; capture.controlId = response.result.control_id;
          capture.waitId = typeof command.params?.wait_id === "string" ? command.params.wait_id : null;
        }
        if (command.command === "authentication.continue_flow" && capture.waitId) {
          capture.signIn = { viewerId: grant.id, waitId: capture.waitId };
        }
        if (command.command === "viewer.open_tab") capture.manualTabs = true;
        if (releasesControl.includes(command.command)) {
          capture.controller = null; capture.controlId = null; capture.waitId = null;
          if (typeof response.result?.page_id === "string" && Number.isSafeInteger(response.result.document_epoch)) {
            capture.pageId = response.result.page_id; capture.epoch = Number(response.result.document_epoch);
          }
          if (navigation.includes(command.command)) {
            capture.frame = null; capture.frameAt = 0;
          }
        }
        if (command.command === "session.status") {
          const status = browserStatusSchema.parse(response.result);
          if (status.browser_generation !== capture.generation) { await this.close(capture); throw new Error("Browser restarted; reopen the viewer"); }
          capture.manualTabs = status.capabilities.includes(MANUAL_TABS_CAPABILITY);
          const selectedPageId = status.selected_page_id ?? capture.pageId;
          const page = status.pages.find((item) => item.page_id === selectedPageId);
          if (!page) { await this.close(capture); throw new Error("Selected browser tab closed; reopen the viewer"); }
          if (capture.signIn && (status.assistance?.wait_id !== capture.signIn.waitId || status.assistance.state !== "checking")) {
            capture.signIn = null;
          }
          if (!status.controlling) { capture.controller = null; capture.controlId = null; capture.waitId = null; }
          if (page.page_id !== capture.pageId || page.document_epoch !== capture.epoch) {
            capture.pageId = page.page_id; capture.epoch = page.document_epoch; capture.frame = null; capture.frameAt = 0;
          }
          response = { ...response, result: { ...status, controlling: capture.controller === grant.id } };
        }
      }
      capture.revision++;
      return { ...response, id: command.id, viewer: this.state(capture, grant.id, grants.length) };
    });
  }
}
