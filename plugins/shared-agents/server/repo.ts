import type { PluginDb } from "@vox/plugin-sdk";

export interface ListingRow {
  id: number; tokenId: number; pricePerUnit: number; ownerId: number; region: string; active: boolean;
}
export interface SettlementRow {
  id: number; jobId: number | null; holdId: number | null;
  payerUserId: number; earnerUserId: number;
  priceUnits: number; pricePerUnit: number; chargeCredits: number; feeCredits: number;
  status: "pending" | "settled" | "refunded";
}

export async function upsertListing(
  db: PluginDb,
  a: { tokenId: number; pricePerUnit: number; ownerId: number; region: string; createdBy: number },
): Promise<void> {
  await db.query(
    `INSERT INTO listings (token_id, price_per_unit, owner_id, region, active, created_by)
     VALUES ($1, $2, $3, $4, true, $5)
     ON CONFLICT (token_id) DO UPDATE SET
       price_per_unit = EXCLUDED.price_per_unit,
       owner_id       = EXCLUDED.owner_id,
       region         = EXCLUDED.region,
       active         = true,
       updated_at     = now()`,
    [a.tokenId, a.pricePerUnit, a.ownerId, a.region, a.createdBy]);
}

export async function deactivateListing(db: PluginDb, tokenId: number): Promise<void> {
  await db.query(`UPDATE listings SET active = false, updated_at = now() WHERE token_id = $1`, [tokenId]);
}

/**
 * Zero-trust region: mirrors Core's `EvalMarketplace.updateListingRegion`
 * (server/marketplace.ts) — called whenever a shared agent's Vox-detected
 * region is (re)assigned or cleared. `region` is NOT NULL on this table, so a
 * clear (region === null, "Unverified") is expressed as deactivating the
 * listing — same delist-until-trusted precedent as `setListing(id, null)`. A
 * non-null region reactivates the listing (mirrors `upsertListing`'s
 * unconditional `active = true`) — otherwise a prior distrust-triggered
 * deactivation would never self-heal once the agent regains a trusted region,
 * since `runAgentLocationCheck` never calls `setListing`. No-op if the token
 * has no listing row.
 */
export async function updateListingRegion(db: PluginDb, tokenId: number, region: string | null): Promise<void> {
  if (region === null) {
    await db.query(`UPDATE listings SET active = false, updated_at = now() WHERE token_id = $1`, [tokenId]);
    return;
  }
  await db.query(`UPDATE listings SET region = $2, active = true, updated_at = now() WHERE token_id = $1`, [tokenId, region]);
}

function mapListing(r: {
  id: string; token_id: string; price_per_unit: string; owner_id: number; region: string; active: boolean;
}): ListingRow {
  return {
    id: Number(r.id), tokenId: Number(r.token_id), pricePerUnit: Number(r.price_per_unit),
    ownerId: Number(r.owner_id), region: r.region, active: r.active,
  };
}

export async function getListing(db: PluginDb, tokenId: number): Promise<ListingRow | null> {
  const { rows } = await db.query<any>(
    `SELECT id, token_id, price_per_unit, owner_id, region, active FROM listings WHERE token_id = $1`, [tokenId]);
  return rows.length === 0 ? null : mapListing(rows[0]);
}

export async function listActiveListings(db: PluginDb): Promise<ListingRow[]> {
  const { rows } = await db.query<any>(
    `SELECT id, token_id, price_per_unit, owner_id, region, active FROM listings WHERE active = true ORDER BY token_id`);
  return rows.map(mapListing);
}

export async function insertPendingSettlement(
  db: PluginDb,
  a: { payerUserId: number; earnerUserId: number; priceUnits: number; pricePerUnit: number; chargeCredits: number; feeCredits: number },
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO settlements
       (payer_user_id, earner_user_id, price_units, price_per_unit, charge_credits, fee_credits)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [a.payerUserId, a.earnerUserId, a.priceUnits, a.pricePerUnit, a.chargeCredits, a.feeCredits]);
  return Number(rows[0].id);
}

export async function setSettlementHold(db: PluginDb, settlementId: number, holdId: number): Promise<void> {
  await db.query(`UPDATE settlements SET hold_id = $2 WHERE id = $1`, [settlementId, holdId]);
}

function mapSettlement(r: any): SettlementRow {
  return {
    id: Number(r.id), jobId: r.job_id === null ? null : Number(r.job_id),
    holdId: r.hold_id === null ? null : Number(r.hold_id),
    payerUserId: Number(r.payer_user_id), earnerUserId: Number(r.earner_user_id),
    priceUnits: Number(r.price_units), pricePerUnit: Number(r.price_per_unit),
    chargeCredits: Number(r.charge_credits), feeCredits: Number(r.fee_credits), status: r.status,
  };
}

export async function getSettlementForUpdate(tx: PluginDb, settlementId: number): Promise<SettlementRow | null> {
  const { rows } = await tx.query<any>(
    `SELECT id, job_id, hold_id, payer_user_id, earner_user_id, price_units, price_per_unit,
            charge_credits, fee_credits, status
     FROM settlements WHERE id = $1 FOR UPDATE`, [settlementId]);
  return rows.length === 0 ? null : mapSettlement(rows[0]);
}

export async function markSettlementTerminal(
  tx: PluginDb, settlementId: number, status: "settled" | "refunded",
  jobId: number | null, artifactValid: boolean, voidReason: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE settlements
     SET status = $2, job_id = $3, artifact_valid = $4, void_reason = $5, settled_at = now()
     WHERE id = $1`,
    [settlementId, status, jobId, artifactValid, voidReason]);
}

export async function getLeakedSettlementIds(db: PluginDb, ttlMs: number, limit: number): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM settlements
     WHERE status = 'pending' AND hold_id IS NOT NULL
       AND created_at < now() - ($1::bigint * interval '1 millisecond')
     ORDER BY id LIMIT $2`, [ttlMs, limit]);
  return rows.map((r) => Number(r.id));
}

export async function countStuckPending(db: PluginDb, ttlMs: number): Promise<number> {
  // Only count pending settlements that carry a placed hold — the same set the
  // leak-reaper acts on (getLeakedSettlementIds). A pending row with hold_id NULL
  // means the process died between insert and hold: either no hold was placed
  // (harmless dead row) or one was and its detection is credits' reconcile job
  // (review I1). Counting those here flapped health `degraded` forever over rows
  // this plugin can't and shouldn't act on (review M2).
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM settlements
     WHERE status = 'pending' AND hold_id IS NOT NULL
       AND created_at < now() - ($1::bigint * interval '1 millisecond')`, [ttlMs]);
  return Number(rows[0].n);
}
