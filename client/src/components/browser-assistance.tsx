import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, MousePointer2, Eye, Loader2, ExternalLink, X, Play, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { browserStatusSchema, browserFrameSchema, type BrowserCommand, type BrowserResponse, type BrowserStatus, type BrowserFrame, type BrowserViewerState } from "@shared/browser-assistance";

type Availability = { available: boolean; target?: "agent" | "broker"; deadline?: string; status?: BrowserStatus };
type View = { id: string; leaseId: string; pageId: string; epoch: number; sessionId: string; generation: string; revision: number };
type Control = { id: string; sequence: number; waitId: string };

async function browserFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json", ...options.headers }, signal: options.signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Browser connection interrupted");
  }
  if (response.status === 204) return null as T;
  return response.json();
}

export function BrowserAssistance({ jobId }: { jobId: number }) {
  const base = `/api/eval-jobs/${jobId}/browser`;
  const { data } = useQuery<Availability>({
    queryKey: [base], queryFn: () => browserFetch(base), refetchInterval: 3000, retry: false,
  });
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [sharing, setSharing] = useState<BrowserViewerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const view = useRef<View | null>(null);
  const control = useRef<Control | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);
  const lifecycle = useRef(0);
  const lastMove = useRef(0);
  const dragging = useRef(false);
  const wheel = useRef<(event: WheelEvent) => void>(() => undefined);
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const stop = useCallback(() => {
    lifecycle.current++;
    const previous = view.current;
    view.current = null; control.current = null; dragging.current = false;
    setOpening(false); setInteractive(false); setSharing(null); setFrame(null); setUrl(""); setText(""); setStatus(null); setReceipt(null);
    if (previous) void browserFetch(`${base}/viewers/${previous.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
  }, [base]);
  useEffect(() => { setOpen(false); setMessage(null); return () => { stop(); }; }, [stop]);

  const command = useCallback(async (name: BrowserCommand["command"], params?: Record<string, unknown>): Promise<BrowserResponse> => {
    const current = view.current;
    if (!current) throw new Error("Viewer is closed");
    const id = crypto.randomUUID();
    try {
      const response = await browserFetch<BrowserResponse>(`${base}/viewers/${current.id}/commands`, {
      method: "POST", body: JSON.stringify({ version: 1, id, command: name,
        session_id: current.sessionId, browser_generation: current.generation, ...(params ? { params } : {}) }),
      });
      if (view.current !== current) throw new Error("Viewer changed; this action will not be repeated");
      if (response.version !== 1 || response.type !== "response" || response.id !== id || typeof response.ok !== "boolean") throw new Error("Invalid browser response");
      if (response.viewer && response.viewer.revision >= current.revision) {
        const shared = response.viewer;
        current.revision = shared.revision;
        if (current.pageId !== shared.page_id || current.epoch !== shared.document_epoch) {
          current.pageId = shared.page_id; current.epoch = shared.document_epoch; setFrame(null);
          control.current = null; setInteractive(false);
        }
        current.leaseId = shared.lease_id; setSharing(shared);
        if (shared.controller !== "you") { control.current = null; setInteractive(false); }
      }
      return response;
    } catch (error) {
      if (view.current === current && !["session.status", "viewer.heartbeat", "command.status"].includes(name)) setReceipt(id);
      throw error;
    }
  }, [base]);
  const identity = () => {
    const current = view.current;
    if (!current) throw new Error("Viewer is closed");
    return { lease_id: current.leaseId, page_id: current.pageId, document_epoch: current.epoch };
  };
  const protocolError = (response: BrowserResponse) => {
    control.current = null; setInteractive(false);
    if (response.error === "OUTCOME_UNKNOWN") setReceipt(response.id);
    throw new Error(response.error === "OUTCOME_UNKNOWN"
      ? "The action may have happened. Inspect the page before taking another action; it will not be repeated automatically."
      : response.error === "CONTROL_BUSY" ? "Another viewer has control. They must release it before you can take control."
      : response.error === "CONTROL_REQUIRED" ? "Take control before changing the shared browser."
      : `Browser state changed (${response.error ?? "unavailable"}). Refresh the view and take control again.`);
  };

  const start = async () => {
    stop();
    const generation = lifecycle.current;
    setOpening(true); setMessage(null); setOpen(true);
    try {
      const availability = await browserFetch<Availability>(base);
      if (generation !== lifecycle.current) return;
      const initial = browserStatusSchema.parse(availability.status);
      if (!initial.browser_generation || !initial.pages.length) throw new Error("The browser is not ready yet");
      const grant = await browserFetch<{ viewerId: string }>(`${base}/viewers`, { method: "POST" });
      if (generation !== lifecycle.current) {
        void browserFetch(`${base}/viewers/${grant.viewerId}`, { method: "DELETE" }).catch(() => undefined);
        return;
      }
      const page = initial.pages[0];
      view.current = { id: grant.viewerId, leaseId: "", pageId: page.page_id, epoch: page.document_epoch,
        sessionId: initial.session_id, generation: initial.browser_generation, revision: 0 };
      const response = await command("viewer.open", { page_id: page.page_id, document_epoch: page.document_epoch });
      if (generation !== lifecycle.current) return;
      if (!response.ok || typeof response.result?.lease_id !== "string") protocolError(response);
      view.current!.leaseId = response.result!.lease_id as string;
      setStatus(initial);
    } catch (error) { if (generation === lifecycle.current) { stop(); setMessage(error instanceof Error ? error.message : "Browser unavailable"); } }
    finally { if (generation === lifecycle.current) setOpening(false); }
  };

  useEffect(() => {
    if (!open || opening) return;
    let disposed = false;
    let heartbeatBusy = false;
    let statusBusy = false;
    let frameBusy = false;
    const fail = (error: unknown) => {
      if (disposed) return;
      stop(); setMessage(error instanceof Error ? error.message : "Browser connection interrupted");
    };
    const heartbeat = setInterval(() => {
      if (!view.current || heartbeatBusy) return;
      heartbeatBusy = true;
      void (async () => {
        const current = view.current!;
        const alive = await command("viewer.heartbeat", { lease_id: current.leaseId });
        if (!alive.ok) throw new Error("Viewer lease expired. Reopen the browser.");
        if (statusBusy || disposed) return;
        statusBusy = true;
        // Keep liveness independent of status, which can wait behind navigation.
        void (async () => {
        const response = await command("session.status");
        if (!response.ok || disposed || view.current !== current) return;
        if (response.viewer && response.viewer.revision < current.revision) return;
        const next = browserStatusSchema.parse(response.result);
        setStatus(next);
        const page = next.pages.find((item) => item.page_id === current.pageId);
        if (next.browser_generation !== current.generation) throw new Error("Browser restarted. Reopen the viewer.");
        if (!page) throw new Error("The selected tab closed. Reopen the browser to choose an active tab.");
        if (page.document_epoch !== current.epoch) {
          current.epoch = page.document_epoch; control.current = null; setInteractive(false); setFrame(null);
        }
        if (!next.controlling || !next.assistance || control.current?.waitId !== next.assistance.wait_id) {
          control.current = null; setInteractive(false);
        }
        })().catch(fail).finally(() => { statusBusy = false; });
      })().catch(fail).finally(() => { heartbeatBusy = false; });
    }, 1000);
    const frames = setInterval(() => {
      const current = view.current;
      if (!current || frameBusy) return;
      frameBusy = true;
      void browserFetch<BrowserFrame | null>(`${base}/viewers/${current.id}/frame`).then((next) => {
        const parsed = browserFrameSchema.safeParse(next);
        if (disposed || !parsed.success || view.current !== current) return;
        const candidate = parsed.data;
        if (candidate.session_id !== current.sessionId || candidate.browser_generation !== current.generation
          || candidate.lease_id !== current.leaseId || candidate.page_id !== current.pageId || candidate.document_epoch !== current.epoch) return;
        setFrame(candidate);
      }).catch(fail).finally(() => { frameBusy = false; });
    }, 200);
    const hide = () => { if (document.hidden) fail(new Error("View closed while this tab is in the background. Reopen when ready.")); };
    document.addEventListener("visibilitychange", hide);
    return () => { disposed = true; clearInterval(heartbeat); clearInterval(frames); document.removeEventListener("visibilitychange", hide); };
  }, [open, opening, base, command, stop]);

  const enqueue = (action: () => Promise<void>) => {
    if (queued.current >= 16) { stop(); setMessage("Input arrived faster than the browser could confirm it. View closed; inspect the page before acting again."); return; }
    queued.current++;
    const expected = control.current;
    const expectedView = view.current;
    queue.current = queue.current.then(async () => {
      if (!expected || control.current !== expected || view.current !== expectedView) return;
      try { await action(); }
      catch (error) { control.current = null; setInteractive(false); setMessage(error instanceof Error ? error.message : "Action outcome unknown; inspect before acting again"); }
    }).finally(() => { queued.current--; });
  };
  const input = async (value: Record<string, unknown>) => {
    const current = control.current;
    if (!current) return;
    const response = await command("viewer.input", { ...identity(), control_id: current.id, sequence: current.sequence, input: value });
    if (!response.ok) protocolError(response);
    if (!Number.isSafeInteger(response.result?.next_sequence)) throw new Error("Invalid browser sequence; inspect before acting again");
    current.sequence = response.result!.next_sequence as number;
  };
  const coordinates = (clientX: number, clientY: number) => {
    const bounds = image.current?.getBoundingClientRect();
    if (!bounds || !frame) return null;
    const width = frame.metadata.deviceWidth;
    const height = frame.metadata.deviceHeight;
    if (!width || !height) return null;
    return { x: Math.max(0, Math.min(width - 1, (clientX - bounds.left) * width / bounds.width)),
      y: Math.max(0, Math.min(height - 1, (clientY - bounds.top) * height / bounds.height)) };
  };
  wheel.current = (event) => {
    if (!control.current) return;
    event.preventDefault();
    if (queued.current > 2) return;
    const point = coordinates(event.clientX, event.clientY);
    const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 500 : 1;
    if (point) enqueue(() => input({ type: "mouse", action: "wheel", ...point,
      delta_x: Math.max(-10000, Math.min(10000, event.deltaX * scale)), delta_y: Math.max(-10000, Math.min(10000, event.deltaY * scale)) }));
  };
  useEffect(() => {
    const element = surface.current;
    const listener = (event: WheelEvent) => wheel.current(event);
    element?.addEventListener("wheel", listener, { passive: false });
    return () => element?.removeEventListener("wheel", listener);
  }, [open, opening]);
  const takeControl = async () => {
    if (!status?.assistance || !view.current) return;
    setBusy(true); setMessage(null);
    try {
      const response = await command("viewer.take_control", { ...identity(), wait_id: status.assistance.wait_id });
      if (!response.ok) protocolError(response);
      if (!view.current || typeof response.result?.control_id !== "string" || !Number.isSafeInteger(response.result.next_sequence)) throw new Error("Browser control changed; reopen the view");
      control.current = { id: String(response.result!.control_id), sequence: Number(response.result!.next_sequence), waitId: status.assistance.wait_id };
      setInteractive(true); surface.current?.focus();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Control unavailable"); }
    finally { setBusy(false); }
  };
  const continueRun = async () => {
    if (!status?.assistance) return;
    setBusy(true);
    try {
      const response = await command("assistance.continue", { ...identity(), wait_id: status.assistance.wait_id });
      if (!response.ok) protocolError(response);
      control.current = null; setInteractive(false); setMessage("Checking the original readiness condition. No login or submission will be repeated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Continuation unavailable"); }
    finally { setBusy(false); }
  };
  const releaseControl = async () => {
    const current = control.current;
    if (!current) return;
    control.current = null; setInteractive(false); setBusy(true);
    try {
      const response = await command("viewer.release_control", { ...identity(), control_id: current.id });
      if (!response.ok) protocolError(response);
      setStatus(null); setMessage("Control released. The evaluation resumes; viewers can take control at the next supported wait.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Control release could not be confirmed. Close and reopen the view."); }
    finally { setBusy(false); }
  };

  if (!data?.available && !open) return null;
  return <>
    <Button variant="outline" className="gap-2" onClick={() => void start()} disabled={opening || open} data-testid="button-open-browser">
      <Monitor className="h-4 w-4" /> Open browser
    </Button>
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) stop(); }}>
      <DialogContent className="w-[calc(100%-1.5rem)] sm:max-w-6xl max-h-[95dvh] p-0 overflow-y-auto" data-testid="browser-assistance-dialog">
        <DialogHeader className="px-5 pt-5 pr-12">
          <DialogTitle className="flex flex-wrap items-center gap-2">Live browser <Badge variant={interactive ? "default" : "secondary"} className="gap-1">
            {interactive ? <MousePointer2 className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{interactive ? "You have control" : "Read-only"}
          </Badge>{sharing && <span className="inline-flex items-center gap-1.5 text-sm font-normal text-muted-foreground" data-testid="browser-viewer-count"><Users className="h-4 w-4" />{sharing.count} {sharing.count === 1 ? "viewer" : "viewers"}</span>}</DialogTitle>
          <DialogDescription>{data?.target === "broker" ? "Secure login browser. Passwords stay in the trusted broker." : "The evaluation's existing browser session."} Everyone shares this view; only one person can control it. Viewing does not pause the evaluation.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 px-5">
          {status && <Select disabled={!interactive || busy} value={view.current?.pageId ?? ""} onValueChange={async (id) => {
            const page = status.pages.find((item) => item.page_id === id);
            if (!page || !view.current) return;
            try {
              const response = await command("viewer.select_page", { ...identity(), target_page_id: page.page_id, target_document_epoch: page.document_epoch });
              if (!response.ok) protocolError(response);
              view.current.pageId = page.page_id; view.current.epoch = page.document_epoch;
              control.current = null; setInteractive(false); setFrame(null);
            } catch (error) { setMessage(error instanceof Error ? error.message : "Tab unavailable"); }
          }}><SelectTrigger className="w-full sm:w-72" aria-label="Browser tab"><SelectValue placeholder="Choose tab" /></SelectTrigger><SelectContent>
            {status.pages.map((page, index) => <SelectItem key={page.page_id} value={page.page_id}>Tab {index + 1} · {page.origin ?? "Loading"}</SelectItem>)}
          </SelectContent></Select>}
          {interactive ? <Button size="sm" variant="outline" onClick={() => void releaseControl()} disabled={busy} title="Release input and resume automation; other viewers stay connected" data-testid="button-release-browser-control">Release control</Button>
            : <Button size="sm" onClick={() => void takeControl()} disabled={busy || sharing?.controller === "other" || !status?.assistance || !view.current} data-testid="button-take-browser-control"><MousePointer2 className="mr-1 h-4 w-4" />{sharing?.controller === "other" ? "Another viewer has control" : "Take control"}</Button>}
          <Button size="sm" variant="outline" onClick={() => void continueRun()} disabled={busy || !interactive || !status?.assistance || !view.current}><Play className="mr-1 h-4 w-4" /> Check &amp; continue</Button>
          {status?.assistance?.remaining_seconds != null && <span className="text-xs text-muted-foreground">Hold: {Math.ceil(status.assistance.remaining_seconds)}s remaining</span>}
        </div>
        <div ref={surface} tabIndex={0} role="group" aria-label="Remote browser viewport" style={{ touchAction: interactive ? "none" : "auto" }} className="min-h-40 max-h-[60vh] overflow-auto bg-muted/50 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onKeyDown={(event) => {
            if (!control.current || event.repeat) return;
            if (event.key === "Escape") return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
            event.preventDefault();
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) enqueue(() => input({ type: "text", text: event.key }));
            else {
              const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
              enqueue(async () => { await input({ type: "key", action: "down", key: event.key, code: event.code, modifiers }); await input({ type: "key", action: "up", key: event.key, code: event.code, modifiers: 0 }); });
            }
          }}
          onPaste={(event) => {
            if (!control.current) return;
            event.preventDefault(); const value = event.clipboardData.getData("text");
            if (value && value.length <= 4096) enqueue(() => input({ type: "text", text: value }));
            else setMessage("Paste at most 4,096 characters at a time.");
          }}
          onContextMenu={(event) => { if (control.current) event.preventDefault(); }}
          onPointerDown={(event) => {
            if (!control.current) return;
            event.preventDefault(); surface.current?.focus(); event.currentTarget.setPointerCapture(event.pointerId); dragging.current = true;
            const point = coordinates(event.clientX, event.clientY);
            if (point) enqueue(() => input({ type: "mouse", action: "down", ...point, button: event.button === 2 ? "right" : "left", click_count: 1 }));
          }}
          onPointerMove={(event) => {
            if (!control.current || !dragging.current || Date.now() - lastMove.current < 100 || queued.current > 2) return;
            lastMove.current = Date.now(); const point = coordinates(event.clientX, event.clientY);
            if (point) enqueue(() => input({ type: "mouse", action: "move", ...point }));
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            const point = coordinates(event.clientX, event.clientY);
            if (point && control.current) enqueue(() => input({ type: "mouse", action: "up", ...point, button: event.button === 2 ? "right" : "left", click_count: 1 }));
          }}
          onPointerCancel={() => { dragging.current = false; stop(); setMessage("Pointer interrupted. Reopen the view to inspect the page."); }}>
          {frame ? <img ref={image} src={`data:image/jpeg;base64,${frame.data}`} alt="Live remote browser" className="mx-auto block w-full select-none" draggable={false} data-testid="browser-frame" />
            : <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{opening ? "Opening secure view" : "Waiting for a browser frame"}</div>}
        </div>
        <div className="space-y-3 px-5 pb-5">
          {interactive && <form className="flex gap-2" onSubmit={(event) => {
            event.preventDefault(); const value = text; setText("");
            if (value) enqueue(() => input({ type: "text", text: value }));
          }}><Input value={text} maxLength={4096} onChange={(event) => setText(event.target.value)} placeholder="Type or paste into the selected field" aria-label="Text to send to browser" autoComplete="off" autoCorrect="off" spellCheck={false} /><Button type="submit" variant="outline" disabled={!text}>Send text</Button></form>}
          {interactive && <form className="flex gap-2" onSubmit={(event) => {
            event.preventDefault(); const selectedUrl = url; setUrl("");
            enqueue(async () => {
              const grant = control.current!;
              const response = await command("viewer.open_url", { ...identity(), control_id: grant.id, sequence: grant.sequence, url: selectedUrl, new_page: true });
              if (!response.ok) protocolError(response);
              view.current!.pageId = String(response.result!.page_id); view.current!.epoch = Number(response.result!.document_epoch);
              control.current = null; setInteractive(false); setFrame(null);
            });
          }}><Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a verification link" aria-label="Verification URL" autoComplete="off" /><Button type="submit" variant="outline" disabled={!url}><ExternalLink className="mr-1 h-4 w-4" /> Open in new tab</Button></form>}
          {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
          {receipt && view.current && <Button size="sm" variant="outline" onClick={async () => {
            try {
              const response = await command("command.status", { lease_id: view.current!.leaseId, command_id: receipt });
              setMessage(response.ok && response.result?.known ? "The browser retained the action's outcome. Inspect the current page before taking another action." : "The outcome cannot be confirmed. The action will not be replayed; inspect the page first.");
            } catch { setMessage("The action's outcome cannot be confirmed. Reopen the view and inspect before acting again."); }
          }}>Check last action receipt</Button>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Click the page to focus. Viewing may use host resources. Login and job deadlines still apply.</span>
            <div className="flex gap-2">{!view.current && <Button size="sm" variant="outline" onClick={() => void start()}><RefreshCw className="mr-1 h-3 w-3" /> Reopen</Button>}<Button size="sm" variant="ghost" onClick={() => { stop(); setOpen(false); }}><X className="mr-1 h-3 w-3" /> Close view</Button></div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
