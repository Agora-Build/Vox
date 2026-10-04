import type { RouteRegistrar, Handler } from "@vox/plugin-sdk";
import type { CreditsService } from "./service";
import type { PersonalCredits } from "./personal";
import type { VerificationProof } from "@vox/plugin-sdk";

function callerId(req: { session?: { userId?: number } }): number | null {
  return req.session?.userId ?? null;
}

export function registerCreditsRoutes(r: RouteRegistrar, service: CreditsService, personal?: PersonalCredits): void {
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
    if (!personal) { res.status(503).json({ error: "Protected grants are unavailable" }); return; }
    try {
      const { verification, ...payload } = req.body ?? {};
      const result = await personal.grant(req, payload, verification as VerificationProof);
      res.status(201).json(result);
    } catch (err) {
      const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 400;
      res.status(status).json({ error: String(err instanceof Error ? err.message : err) });
    }
  };

  const usage: Handler = async (req, res) => {
    if (!personal) { res.status(503).json({ error: "Usage reporting unavailable" }); return; }
    res.json(await personal.usage(req.session.userId!));
  };

  const accounts: Handler = async (req, res) => {
    const q = (req as never as { query: Record<string, string | undefined> }).query;
    const uid = q.userId !== undefined ? Number(q.userId) : NaN;
    if (!Number.isSafeInteger(uid)) { res.status(400).json({ error: "userId query param required" }); return; }
    const account = personal ? await personal.inspect(uid) : { balance: await service.getBalance(uid), recent: (await service.getStatement(uid, { limit: 100 })).entries };
    res.json({ userId: uid, ...account });
  };

  r.get("/balance", r.requireAuth, balance);
  r.get("/statement", r.requireAuth, statement);
  r.get("/usage", r.requireAuth, usage);
  // requireAuth first (Core convention): requireAdmin alone does not reject a
  // disabled account, so chaining guards against a disabled admin with a live
  // session still reaching these money-admin endpoints.
  r.post("/grants", r.requireAuth, r.requireAdmin, grants);
  r.get("/accounts", r.requireAuth, r.requireAdmin, accounts);
}
