import type { Express, Request, Response } from "express";
import { z } from "zod";
import { ACCOUNT_CHECKPOINT_LIMITS, engineSessionIdSchema, accountCheckpointSchema } from "@shared/account-session-protocol";
import { hashToken } from "./storage";
import { AccountSessionError } from "./account-session-binding";
import { accountSessionStore, authorityForAccountGrant, decodeAccountSessionGrant, prepareRuntimeAccountSession } from "./account-session-service";

const prepareSchema = z.object({ sessionId: engineSessionIdSchema, leaseId: z.string().min(1).max(128), startedAt: z.string().datetime(),
  credentialRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const deliverySchema = z.object({ grant: z.string().max(16_384), record: accountCheckpointSchema,
  state: z.string().max(ACCOUNT_CHECKPOINT_LIMITS.snapshotBytes) }).strict();
const releaseSchema = z.object({ grant: z.string().max(16_384) }).strict();

function fail(res: Response, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ status: "rejected", error: "Invalid account-session request" });
  if (error instanceof AccountSessionError) {
    return res.status(error.code === "unauthorized" ? 403 : error.code === "state-unavailable" ? 503 : 422)
      .json({ status: error.code === "state-unavailable" ? "retryable" : "rejected", error: error.message });
  }
  // Never log request bodies, grants, state, provider replies or database errors.
  return res.status(503).json({ status: "retryable", error: "Account-session persistence unavailable" });
}

function tokenHash(req: Request) {
  const bearer = req.headers.authorization;
  if (!bearer?.startsWith("Bearer ") || bearer.length > 20_000) throw new AccountSessionError("unauthorized");
  return hashToken(bearer.slice(7));
}

export function registerAccountSessionRoutes(app: Express) {
  app.post("/api/eval-agent/jobs/:jobId/account-session", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const input = prepareSchema.parse(req.body), jobId = z.coerce.number().int().positive().parse(req.params.jobId);
      return res.json(await prepareRuntimeAccountSession({ ...input, jobId, tokenHash: tokenHash(req) }));
    } catch (error) { return fail(res, error); }
  });

  const receive = (broker: boolean, release: boolean) => async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      const brokerTokenHash = broker ? tokenHash(req) : null;
      const input = release ? releaseSchema.parse(req.body) : deliverySchema.parse(req.body);
      const { context, ticket } = decodeAccountSessionGrant(input.grant);
      if (broker ? context.kind !== "brokered" : context.kind !== "runtime" ||
        context.jobId !== Number(req.params.jobId) || context.tokenHash !== tokenHash(req)) throw new AccountSessionError("unauthorized");
      if (context.kind === "brokered" && context.checkpointTokenHash !== brokerTokenHash) throw new AccountSessionError("unauthorized");
      if (!ticket) throw new AccountSessionError("unauthorized");
      const authorize = authorityForAccountGrant(context);
      if (release) return res.json({ released: await accountSessionStore.release(authorize, ticket) });
      const { record, state } = input as z.infer<typeof deliverySchema>;
      if (record.session_id !== context.sessionId || record.snapshot !== `snapshots/${context.sessionId}/${record.snapshot_id}.json` ||
          record.byte_length !== Buffer.byteLength(state)) throw new AccountSessionError("invalid-checkpoint");
      const result = await accountSessionStore.save(authorize, ticket, {
        checkpointId: record.snapshot_id, sequence: record.sequence, format: record.storage_format, state,
      });
      return res.json(result.status === "persisted" ? { status: "persisted", sessionId: context.sessionId,
        snapshotId: result.checkpointId, committedAt: result.committedAt } : result);
    } catch (error) { return fail(res, error); }
  };
  app.post("/api/eval-agent/jobs/:jobId/account-session/checkpoints", receive(false, false));
  app.post("/api/eval-agent/jobs/:jobId/account-session/release", receive(false, true));
  // Core supplies a separate per-mint bearer proof to the selected broker.
  // The encrypted grant alone cannot restore or replace account state.
  app.post("/api/brokers/account-session/checkpoints", receive(true, false));
  app.post("/api/brokers/account-session/release", receive(true, true));
  app.post("/api/brokers/account-session/restore", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const brokerTokenHash = tokenHash(req);
      const { grant } = releaseSchema.parse(req.body);
      const { context } = decodeAccountSessionGrant(grant);
      if (context.kind !== "brokered" || context.checkpointTokenHash !== brokerTokenHash) throw new AccountSessionError("unauthorized");
      return res.json({ state: (await accountSessionStore.read(authorityForAccountGrant(context)))?.state ?? null });
    } catch (error) { return fail(res, error); }
  });
}
