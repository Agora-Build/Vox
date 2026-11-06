import type { Express, Request } from "express";
import { z } from "zod";
import { getCurrentUser, requireAuth, requireOrgAdmin } from "./auth";
import { getCredentialTrialPolicy, setCredentialTrialPolicy } from "./credential-trials";

const policySchema = z.object({ enabled: z.boolean(), maxRuns30Days: z.number().int().min(0).max(10000) })
  .refine((p) => !p.enabled || p.maxRuns30Days > 0, "Set a positive run budget before enabling trials");

export function registerCredentialTrialRoutes(app: Express) {
  for (const scope of ["personal", "organization"] as const) {
    const guards = scope === "organization" ? [requireAuth, requireOrgAdmin] : [requireAuth];
    const scopeFor = async (req: Request) => {
      const user = await getCurrentUser(req);
      if (!user) return null;
      return scope === "personal" ? `user:${user.id}`
        : user.membership && ["owner", "admin"].includes(user.membership.role) ? `org:${user.membership.organizationId}` : null;
    };
    app.get(`/api/credential-trials/${scope}`, ...guards, async (req, res) => {
      try {
        const key = await scopeFor(req);
        if (!key) return res.status(403).json({ error: "Not authorized to manage this credential scope" });
        res.json(await getCredentialTrialPolicy(key));
      } catch {
        res.status(500).json({ error: "Failed to load trial settings" });
      }
    });
    app.put(`/api/credential-trials/${scope}`, ...guards, async (req, res) => {
      const parsed = policySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Provide enabled and a run budget from 1 to 10,000 (0 only when disabled)" });
      try {
        const key = await scopeFor(req);
        if (!key) return res.status(403).json({ error: "Not authorized to manage this credential scope" });
        await setCredentialTrialPolicy(key, parsed.data);
        res.json(await getCredentialTrialPolicy(key));
      } catch {
        res.status(500).json({ error: "Failed to save trial settings" });
      }
    });
  }
}
