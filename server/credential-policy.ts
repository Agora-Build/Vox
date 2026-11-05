// Living policy: designs/agent-credentials-design.md. Update it with policy changes.
export interface CredentialOwner {
  ownerId: number;
  organizationId: number | null;
}

export interface CredentialAgent {
  createdBy: number;
  dispatchTier: string;
  organizationId: number | null;
}

export function isPersonalCredentialAgent(flow: CredentialOwner, agent: Pick<CredentialAgent, "createdBy">): boolean {
  return flow.organizationId == null && flow.ownerId === agent.createdBy;
}

/** Token identity and membership must come from Core, never agent metadata. */
export function credentialAgentViolation(
  flow: CredentialOwner,
  agent: CredentialAgent,
  runtime: boolean,
): string | null {
  if (agent.dispatchTier === "public") return null;
  if (agent.dispatchTier === "shared") {
    if (isPersonalCredentialAgent(flow, agent)) return null;
    return runtime ? "Shared agents require Brokered secrets. Runtime secrets cannot be sent to Shared agents." : null;
  }
  if (agent.dispatchTier === "team") {
    return flow.organizationId != null && flow.organizationId === agent.organizationId
      ? null : "Team agents can only use secrets belonging to their organization, never personal secrets.";
  }
  if (agent.dispatchTier === "private") {
    return flow.organizationId == null && flow.ownerId === agent.createdBy
      ? null : "Private agents can only use their owner's personal secrets. Use a Team agent for organization secrets.";
  }
  return "This agent is not authorized to receive credentials.";
}

export function credentialPoolViolation(
  tier: string,
  flow: CredentialOwner,
  caller: { id: number; organizationId: number | null },
): string | null {
  if (tier === "shared") return "Shared agents must be selected individually, not as a credential pool.";
  return credentialAgentViolation(flow, {
    createdBy: caller.id, dispatchTier: tier, organizationId: caller.organizationId,
  }, false);
}

export function ownsCredentialScope(flow: CredentialOwner, caller: { id: number; organizationId: number | null }): boolean {
  return flow.organizationId != null
    ? flow.organizationId === caller.organizationId : flow.ownerId === caller.id;
}
