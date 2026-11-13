import { browserAgents, hasBrowserAssistance } from "./browser-agent-bridge";
import { credentialKeyFor, sessionScopeForEvalFlow, classifyReferencedSecrets } from "./auth-session";
import { fetchViaBroker, getBrokerTarget } from "./broker-registry";
import { storage } from "./storage";
import { canCreateEvalFlowSecrets, type AuthUser } from "./permissions";
import type { BrowserTarget } from "./browser-viewers";
import type { BrowserOperation } from "@shared/browser-assistance";
import type { EvalJob } from "@shared/schema";

export function canAccessJobBrowser(user: AuthUser, job: Pick<EvalJob, "createdBy" | "snapshot">): boolean {
  const flow = job.snapshot?.evalFlow;
  if (!flow || !canCreateEvalFlowSecrets(user, { ownerId: flow.ownerId, organizationId: flow.organizationId ?? null })) return false;
  // Personal browser access requires ownership AND launch authority; org managers act for their org.
  return flow.organizationId != null || job.createdBy === user.id;
}
export class BrowserAccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function sendBrowserTarget(target: BrowserTarget, operation: BrowserOperation): Promise<unknown> {
  if (target.kind === "agent") return browserAgents.request(target.agentId, target.leaseId,
    { jobId: target.jobId, startedAt: target.startedAt }, operation, target.generation);
  const broker = await storage.getBroker(target.brokerId);
  const destination = broker && await getBrokerTarget(broker);
  if (!destination?.owner || destination.owner.generation !== target.generation) throw new BrowserAccessError(410, "Broker connection changed; reopen the viewer");
  const response = await fetchViaBroker(destination, "/browser", JSON.stringify({ operationId: target.operationId, ...operation }), 12_000);
  if (!response.ok) throw new BrowserAccessError(503, "Broker browser unavailable; an input outcome may be unknown");
  return (await response.json()).result;
}
export async function resolveBrowserTarget(job: EvalJob): Promise<BrowserTarget | null> {
  const injection = job.snapshot?.sessionInjection;
  const frozenFlow = job.snapshot?.evalFlow;
  if (injection && frozenFlow) {
    const scope = sessionScopeForEvalFlow({ ownerId: frozenFlow.ownerId, organizationId: frozenFlow.organizationId ?? null });
    const classes = await classifyReferencedSecrets(scope, new Set([injection.emailSecret, injection.passwordSecret]));
    if (classes.some((item) => !item.present || item.brokerType !== "auth-session")) throw new BrowserAccessError(403, "Login credential classification changed");
    const session = await storage.getWebSession(scope, injection.platformId, credentialKeyFor(injection));
    if (session?.status === "minting" && session.mintBrokerId && session.mintOperationId && session.mintDeadlineAt
      && session.mintDeadlineAt.getTime() > Date.now()) {
      const broker = await storage.getBroker(session.mintBrokerId);
      const token = broker && await storage.getBrokerRegistrationToken(broker.tokenId);
      const destination = broker && await getBrokerTarget(broker);
      if (!broker || !token || token.isRevoked || (token.expiresAt && token.expiresAt <= new Date())
        || broker.state === "offline" || !destination?.owner) return null;
      return {
        key: `broker:${broker.id}:${session.mintOperationId}:${destination.owner.generation}`, kind: "broker", brokerId: broker.id,
        operationId: session.mintOperationId, generation: destination.owner.generation, deadline: session.mintDeadlineAt.toISOString(),
      };
    }
  }
  if (job.status !== "running" || !job.evalAgentId || !job.startedAt) return null;
  const agent = await storage.getEvalAgent(job.evalAgentId);
  if (!agent?.currentLeaseId || !hasBrowserAssistance(agent.metadata)) return null;
  const token = await storage.getEvalAgentToken(agent.tokenId);
  if (!token || token.isRevoked) return null;
  const owner = await browserAgents.owner(agent.id, agent.currentLeaseId);
  if (!owner) return null;
  const execution = { jobId: job.id, startedAt: job.startedAt.toISOString() };
  return { key: `agent:${agent.id}:${agent.currentLeaseId}:${execution.jobId}:${execution.startedAt}:${owner.generation}`, kind: "agent",
    agentId: agent.id, leaseId: agent.currentLeaseId, generation: owner.generation, ...execution };
}
