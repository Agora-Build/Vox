import type { EvalJob } from "@shared/schema";

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
  region: string;
  createdBy: number;
}

export interface DispatchAuthorization {
  ok: boolean;
  reason?: string;
  /** Opaque blob Core stashes verbatim into the job snapshot; never inspected by Core. */
  settlementContext?: unknown;
}

/**
 * Optional seam Core defines and resolves once at startup. Filled ONLY by the
 * `shared-agents` plugin (Phase B). Core carries money-shaped data but never
 * interprets it. Absent → `shared` is inert.
 */
export interface EvalMarketplace {
  listDispatchable(userId: number): Promise<AgentSummary[]>;
  authorizeDispatch(userId: number, tokenId: number, jobContext: JobContext): Promise<DispatchAuthorization>;
  settle(job: EvalJob): Promise<void>; // capture | release, idempotent by job id
  setListing(tokenId: number, pricePerUnit: number | null): Promise<void>;
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
