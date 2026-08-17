// Canonical region values for integration tests.
//
// The region model (migration 0023 / shared/regions.ts) requires fully-qualified
// site IDs of the form `<base_id>-<NN>` (e.g. "na-us-seattle-01"). Bare macro
// codes like "na"/"eu"/"apac"/"sa" are NO LONGER valid region values — token,
// job, and schedule creation reject them, and job/schedule region fields store
// the full site ID.
//
// Migration 0023 seeds these bases with `next_sequence >= 2`, so `<base>-01` is
// guaranteed to be an already-allocated site on any migrated database. Use the
// REGION_* site IDs anywhere a concrete, pre-allocated region is needed (job /
// schedule / metrics-filter region fields and their assertions). Use the BASE_*
// base IDs when CREATING an eval-agent token (`regionLocationBaseId`) — the
// server allocates the next sequence for that base and returns the resolved
// site region in the response, which callers should read rather than assume.

// Pre-allocated site IDs (guaranteed by migration 0023's next_sequence >= 2).
export const REGION_NA = "na-us-seattle-01";
export const REGION_EU = "eu-de-frankfurt-01";
export const REGION_APAC = "apac-sg-01";
export const REGION_SA = "sa-br-saopaulo-01";

// Base IDs for token creation (regionLocationBaseId). Distinct bases so agents
// created for NA/EU/APAC land in genuinely different regions.
export const BASE_NA = "na-us-seattle";
export const BASE_EU = "eu-de-frankfurt";
export const BASE_APAC = "apac-sg";
export const BASE_SA = "sa-br-saopaulo";
