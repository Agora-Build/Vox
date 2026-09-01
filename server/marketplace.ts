/** One targetable agent, as surfaced to a renter browsing `/dispatchable`. */
export interface AgentSummary {
  tokenId: number;
  region: string;
  pricePerUnit: number; // whole credits per unit; only meaningful for `shared`
  ownerId: number;
}

/** Opaque-to-Core context the plugin needs to price and gate a dispatch. */
export interface JobContext {
  workflowId: number | null;
  evalSetId: number | null;
  region: string | null;
  createdBy: number;
}

export interface DispatchAuthorization {
  ok: boolean;
  reason?: string;
  /** Opaque blob Core stashes verbatim into the job snapshot; never inspected by Core. */
  settlementContext?: unknown;
}

/**
 * The money-relevant projection of a terminal eval job, built by Core and handed
 * to the marketplace seam. Core owns this DTO so the plugin never imports Core's
 * `EvalJob` (Plugin/Core boundary). `hasResult` is the artifact gate: capture is
 * allowed ONLY for a `completed` job that actually produced an eval-result row — a
 * bare self-reported completion with no result is refunded, never paid (review H1).
 */
export interface SettlementOutcome {
  jobId: number;
  status: string;             // job status; only 'completed'/'failed' are settle-able
  hasResult: boolean;         // a real evalResults row exists for the job
  settlementContext: unknown; // opaque marker Core stashed into the snapshot at dispatch
}

/**
 * Optional seam Core defines and resolves once at startup. Filled ONLY by the
 * `shared-agents` plugin. Core carries money-shaped data but never
 * interprets it. Absent → `shared` is inert.
 */
export interface EvalMarketplace {
  listDispatchable(userId: number): Promise<AgentSummary[]>;
  authorizeDispatch(userId: number, tokenId: number, jobContext: JobContext): Promise<DispatchAuthorization>;
  settle(outcome: SettlementOutcome): Promise<void>; // capture | release, idempotent by settlement
  /**
   * Compensating release when a dispatch was authorized (escrow hold placed) but the
   * job was never created — releases the hold immediately instead of stranding it for
   * the leak-reaper. Idempotent; no-op if already terminal (review M4).
   */
  voidDispatch(settlementContext: unknown): Promise<void>;
  setListing(tokenId: number, pricePerUnit: number | null, meta?: { ownerId: number; region: string }): Promise<void>;
}

let current: EvalMarketplace | null = null;

/** Called once at startup (server/index.ts) with the resolved seam or null. */
export function setMarketplace(m: EvalMarketplace | null): void {
  current = m;
}

/** null when no plugin provides `vox.eval-marketplace`. */
export function getMarketplace(): EvalMarketplace | null {
  return current;
}
