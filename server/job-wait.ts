import { isClaimable } from "./permissions";
import { compareVersions } from "./aeval-seed";

// Why a pending job is still pending, for the job page.
//
// An eval agent only ever SEES the jobs it may claim (GET /api/eval-agent/jobs
// is filtered by the claim rule), so a job no online agent may take just sits
// there while every agent looks healthy: heartbeats fine, polls empty. This
// runs that same rule — permissions.isClaimable, which the claim SQL mirrors —
// over the agents online right now, and when none qualifies, says which
// requirement nobody meets.

/**
 * Zero-trust effective dispatch identity: public agents carry their configured
 * (admin-trusted) token region; everything else carries the agent's DETECTED
 * region — null for Unverified, which structurally fails every region-pooled
 * match. (spec: dispatch gating) Shared by the claim routes and the waiting
 * explanation, so the two can't disagree.
 */
export function effectiveDispatchIdentity(
  token: { siteId: string | null; region: string | null; dispatchTier: string },
  agent: { siteId: string | null; region: string | null; locationTrust: string } | undefined,
): { siteId: string | null; region: string | null; locationTrust: string } {
  return token.dispatchTier === "public"
    ? { siteId: token.siteId, region: token.region, locationTrust: "trusted" }
    : { siteId: agent?.siteId ?? null, region: agent?.region ?? null, locationTrust: agent?.locationTrust ?? "unknown" };
}

/**
 * The second filter on an agent's job list, after the claim rule: never hand a
 * session-injected job to a daemon that can't force storage mode (it would run
 * the target unauthenticated), nor a job needing a newer framework than the
 * agent has. Returns why not, or null when the agent may see the job. Shared
 * by GET /api/eval-agent/jobs and the waiting explanation.
 */
export function agentListFilter(jobConfig: unknown, agentMetadata: unknown): string | null {
  const cfg = (jobConfig as Record<string, unknown>) ?? {};
  const meta = (agentMetadata as Record<string, unknown>) ?? {};
  if (cfg.sessionInjection && meta.sessionInjection !== "1") return "its build can't use a login session";
  const agentVersion = meta.frameworkVersion as string | undefined;
  const jobVersion = cfg.frameworkVersion as string | undefined;
  if (agentVersion && jobVersion && compareVersions(jobVersion, agentVersion) > 0) return `it runs aeval ${agentVersion}; this job needs ${jobVersion} or newer`;
  return null;
}

/** One eval agent as the claim rule sees it: the token's LATEST agent row. */
export interface WaitAgent {
  name: string;
  tokenId: number;
  state: string;
  lastSeenAt: Date | string | null;
  capabilities: unknown;
  metadata: unknown;
  siteId: string | null;
  region: string | null;
  locationTrust: string;
  tokenCreatedBy: number;
  tokenDispatchTier: string;
  tokenRegion: string | null;
  tokenSiteId: string | null;
  tokenIsRevoked: boolean;
  /** The token owner's org (team arm), resolved by the caller. */
  tokenOwnerOrgId: number | null;
}

export interface WaitJob {
  targetTokenId: number | null;
  targetRegion: string | null;
  targetTier: "private" | "team" | "public" | "shared" | null;
  siteId: string | null;
  createdBy: number | null;
  creatorOrgId: number | null;
  transport: "web" | "phone" | null;
  kind: "eval" | "analyze";
  sessionInjected: boolean;
  config: unknown;
}

export interface Waiting {
  /** Online agents the claim rule lets take this job. */
  canTake: number;
  /** …of which busy with another job right now. */
  busy: number;
  /** What's holding it, in words. */
  message: string;
}

const hasCap = (caps: unknown, c: string) => Array.isArray(caps) && (caps as unknown[]).includes(c);

/**
 * @param agents every agent row with its token (newest first, as the claim
 *   route takes `agents[0]` per token); revoked and offline ones are skipped here.
 * @param viewerId names are shown only for the viewer's own agents — anyone
 *   else's appear as counts.
 */
export function explainWaiting(
  job: WaitJob,
  agents: WaitAgent[],
  viewerId: number,
  opts: { now?: Date; onlineWithinMinutes?: number } = {},
): Waiting {
  const now = opts.now ?? new Date();
  const onlineMs = (opts.onlineWithinMinutes ?? 5) * 60_000;
  // The claim route decides on each token's latest agent row.
  const latestPerToken = new Map<number, WaitAgent>();
  for (const a of agents) if (!latestPerToken.has(a.tokenId)) latestPerToken.set(a.tokenId, a);
  const seenAgo = (a: WaitAgent) => a.lastSeenAt == null ? Infinity : now.getTime() - new Date(a.lastSeenAt).getTime();
  const all = Array.from(latestPerToken.values()).filter((a) => !a.tokenIsRevoked);
  const online = all.filter((a) => a.state !== "offline" && seenAgo(a) <= onlineMs);

  const claims = (a: WaitAgent, override: { phone?: boolean; analyze?: boolean } = {}) => {
    const eff = effectiveDispatchIdentity(
      { siteId: a.tokenSiteId, region: a.tokenRegion, dispatchTier: a.tokenDispatchTier },
      { siteId: a.siteId, region: a.region, locationTrust: a.locationTrust },
    );
    return isClaimable(
      job,
      {
        id: a.tokenId,
        dispatchTier: a.tokenDispatchTier as never,
        createdBy: a.tokenCreatedBy,
        region: eff.region ?? undefined,
        siteId: eff.siteId ?? undefined,
        phoneCapable: override.phone ?? hasCap(a.capabilities, "phone"),
        analyzeCapable: override.analyze ?? hasCap(a.capabilities, "analyze"),
      },
      { tokenOwnerOrgId: a.tokenOwnerOrgId, creatorOrgId: job.creatorOrgId },
    );
  };
  const mine = (list: WaitAgent[]) => list.filter((a) => a.tokenCreatedBy === viewerId).map((a) => `'${a.name}'`);
  const yours = (names: string[]) => names.length ? ` Your agent${names.length > 1 ? "s" : ""} ${names.join(", ")} ${names.length > 1 ? "are" : "is"} among them.` : "";
  const agentsWord = (n: number) => `${n} online agent${n === 1 ? "" : "s"}`;

  const eligible = online.filter((a) => claims(a));
  const takers = eligible.filter((a) => agentListFilter(job.config, a.metadata) == null);
  if (takers.length > 0) {
    const busy = takers.filter((a) => a.state === "occupied").length;
    return {
      canTake: takers.length,
      busy,
      message: busy === takers.length
        ? `${agentsWord(takers.length)} can take this job, all busy with other jobs right now — it starts when one frees up.`
        : `${agentsWord(takers.length)} can take this job; one should pick it up within seconds.`,
    };
  }

  // The claim rule allows some, but their builds can't run it.
  if (eligible.length > 0) {
    const why = Array.from(new Set(eligible.map((a) => agentListFilter(job.config, a.metadata))));
    return {
      canTake: 0, busy: 0,
      message: `${agentsWord(eligible.length)} may take this job but can't run it: ${why.join("; ")}. Upgrade ${eligible.length === 1 ? "it" : "them"} with vox-upgrade.sh.${yours(mine(eligible))}`,
    };
  }

  // Nobody online may take it. Which requirement is it?
  const isPhone = job.transport === "phone" && job.kind !== "analyze";
  if (isPhone) {
    const butForPhone = online.filter((a) => claims(a, { phone: true }));
    if (butForPhone.length > 0) {
      return {
        canTake: 0, busy: 0,
        message: `Waiting for an agent with phone capability. ${agentsWord(butForPhone.length)} would take this phone job but ${butForPhone.length === 1 ? "isn't" : "aren't"} reporting phone — an agent reports it only while its DialF check passes (dialfd running and reachable, a phone connected); its log says why ("DialF probe: unavailable (…)").${yours(mine(butForPhone))}`,
      };
    }
  }
  if (job.kind === "analyze") {
    const butForAnalyze = online.filter((a) => claims(a, { analyze: true }));
    if (butForAnalyze.length > 0) {
      return {
        canTake: 0, busy: 0,
        message: `Waiting for an agent that can run analyses (it needs aeval on its host). ${agentsWord(butForAnalyze.length)} would take it otherwise.${yours(mine(butForAnalyze))}`,
      };
    }
  }
  // Would an agent take it if it were online?
  const offline = all.filter((a) => !online.includes(a) && claims(a, isPhone ? { phone: true } : {}));
  const target = job.targetTokenId != null
    ? "the one agent it was sent to"
    : job.targetRegion != null
      ? `a ${job.targetTier ?? "?"}-tier agent in ${job.targetRegion}`
      : job.siteId != null ? `an agent at site ${job.siteId}` : "a matching agent";
  if (offline.length > 0) {
    const names = mine(offline);
    return {
      canTake: 0, busy: 0,
      message: `Waiting for ${target}: ${offline.length === 1 ? "the one that matches is" : `the ${offline.length} that match are`} offline.${names.length ? ` Yours: ${names.join(", ")}.` : ""}`,
    };
  }
  return { canTake: 0, busy: 0, message: `Waiting for ${target}: no agent matches it.` };
}
