import { z } from "zod";
import { BrowserCaptures, type CaptureRequest } from "./browser-capture";
import { browserViewers, type BrowserGrant, type BrowserTarget } from "./browser-viewers";
import { coreRouting } from "./core-routing-runtime";
import type { CoreOwner } from "./core-routing";
import { browserCommandSchema } from "@shared/browser-assistance";
import { BrowserAccessError, canAccessJobBrowser, resolveBrowserTarget, sendBrowserTarget } from "./browser-target";
import { storage } from "./storage";
import { jobMayUseCredentials } from "./credential-trials";
import { getOrganizations } from "./organizations";

async function authorizedGrant(grant: BrowserGrant): Promise<boolean> {
  const user = await storage.getUser(grant.userId);
  const job = await storage.getEvalJob(grant.jobId);
  const membership = user ? await getOrganizations()?.getMembership(user.id) ?? null : null;
  if (user?.isEnabled && job && ["running", "pending"].includes(job.status) && job.transport === "web" && job.kind === "eval"
    && canAccessJobBrowser({ ...user, membership }, job) && await jobMayUseCredentials(job)
    && (await resolveBrowserTarget(job))?.key === grant.target.key) return true;
  await browserViewers.remove(grant.id);
  return false;
}
const captures = new BrowserCaptures((key) => browserViewers.list(key), sendBrowserTarget, authorizedGrant);
const requestSchema = z.object({ channel: z.literal("browser-viewer"), targetKey: z.string().min(1).max(1024),
  viewerId: z.string().uuid(), action: z.enum(["command", "frame", "leave"]), request: browserCommandSchema.optional(),
}).strict();
function matchesOwner(target: BrowserTarget, owner: CoreOwner): boolean {
  return target.kind === owner.kind && target.generation === owner.generation
    && (target.kind === "agent" ? target.agentId === owner.resourceId && target.leaseId === owner.leaseId : target.brokerId === owner.resourceId);
}
coreRouting.handleChannel("browser-viewer", async (payload, owner) => {
  const input = requestSchema.parse(payload);
  if (input.action !== "leave") {
    const grant = await browserViewers.get(input.viewerId);
    if (!grant || grant.target.key !== input.targetKey || !matchesOwner(grant.target, owner)) throw new Error("Viewer owner changed");
  }
  return captures.handle(input);
});
const cleanup = setInterval(() => { void captures.maintain(); }, 1000);
cleanup.unref();

export async function requestBrowserCapture(grant: BrowserGrant, action: CaptureRequest["action"], request?: CaptureRequest["request"]): Promise<unknown> {
  const target = grant.target;
  const owner = await coreRouting.find(target.kind, target.kind === "agent" ? target.agentId : target.brokerId);
  if (!owner || !matchesOwner(target, owner)) throw new BrowserAccessError(410, "Browser connection changed; reopen the viewer");
  return coreRouting.request(owner, { channel: "browser-viewer", targetKey: target.key, viewerId: grant.id, action, ...(request ? { request } : {}) });
}
