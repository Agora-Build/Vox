import type { RouteRegistrar, Handler } from "@vox/plugin-sdk";
import type { CreditsService } from "./service";

function callerId(req: { session?: { userId?: number } }): number | null {
  return req.session?.userId ?? null;
}

export function registerCreditsRoutes(r: RouteRegistrar, service: CreditsService): void {
  const balance: Handler = async (req, res) => {
    const uid = callerId(req as never);
    if (uid == null) { res.status(401).json({ error: "Authentication required" }); return; }
    const credits = await service.getBalance(uid);
    res.json({ credits, asOf: new Date().toISOString() });
  };

  const statement: Handler = async (req, res) => {
    const uid = callerId(req as never);
    if (uid == null) { res.status(401).json({ error: "Authentication required" }); return; }
    const q = (req as never as { query: Record<string, string | undefined> }).query;
    const n = q.limit !== undefined ? Number(q.limit) : undefined;
    const limit = Number.isFinite(n) ? n : undefined;
    const page = await service.getStatement(uid, { limit, cursor: q.cursor });
    res.json(page);
  };

  const grants: Handler = async (req, res) => {
    const body = (req as never as { body: Record<string, unknown> }).body ?? {};
    const userId = body.userId, credits = body.credits, reason = body.reason, idempotencyKey = body.idempotencyKey;
    if (typeof userId !== "number" || typeof credits !== "number" ||
        typeof reason !== "string" || typeof idempotencyKey !== "string") {
      res.status(400).json({ error: "userId, credits, reason, idempotencyKey are required" });
      return;
    }
    try {
      const result = await service.deposit({ userId, credits, reason, idempotencyKey });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  };

  const accounts: Handler = async (req, res) => {
    const q = (req as never as { query: Record<string, string | undefined> }).query;
    const uid = q.userId !== undefined ? Number(q.userId) : NaN;
    if (!Number.isSafeInteger(uid)) { res.status(400).json({ error: "userId query param required" }); return; }
    const balance = await service.getBalance(uid);
    const statement = await service.getStatement(uid, { limit: 100 });
    res.json({ userId: uid, balance, recent: statement.entries });
  };

  r.get("/balance", r.requireAuth, balance);
  r.get("/statement", r.requireAuth, statement);
  // requireAuth first (Core convention): requireAdmin alone does not reject a
  // disabled account, so chaining guards against a disabled admin with a live
  // session still reaching these money-admin endpoints.
  r.post("/grants", r.requireAuth, r.requireAdmin, grants);
  r.get("/accounts", r.requireAuth, r.requireAdmin, accounts);
}
