-- Zero-trust region: a token's site/region is no longer known at mint time for
-- non-public tiers (region is public-tier-only at mint; other tiers are detected
-- later via agent register/heartbeat). Switching a private/team token straight to
-- "shared" before that detection lands must be able to upsert a listing with no
-- region yet — drop the NOT NULL constraint so that write no longer crashes.
-- `upsertListing` (server/repo.ts) treats a null region as delisted-until-trusted
-- (active = false), mirroring `updateListingRegion(tokenId, null)`'s existing
-- deactivate semantics; a later `updateListingRegion(tokenId, region)` reactivates
-- once the agent's region is trust-detected.
ALTER TABLE listings ALTER COLUMN region DROP NOT NULL;
