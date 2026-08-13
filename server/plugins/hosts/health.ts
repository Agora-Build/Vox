import type { Express } from "express";
import type { HealthReport } from "@vox/plugin-sdk";

interface Meta { version: string; provides: string[]; requires: string[]; }

export class HealthHost {
  private checks = new Map<string, () => Promise<HealthReport>>();
  private meta = new Map<string, Meta>();

  register(pluginId: string, check: () => Promise<HealthReport>): void {
    this.checks.set(pluginId, check);
  }

  setMeta(pluginId: string, meta: Meta): void {
    this.meta.set(pluginId, meta);
  }

  routes(app: Express): void {
    app.get("/api/plugins", (_req, res) => {
      res.json(
        Array.from(this.meta).map(([id, m]) => ({
          id,
          version: m.version,
          servicesProvided: m.provides,
          servicesRequired: m.requires,
        })),
      );
    });

    app.get("/api/plugins/:id/health", async (req, res) => {
      const check = this.checks.get(req.params.id);
      if (!check) {
        res.status(404).json({ status: "down", detail: "unknown plugin" });
        return;
      }
      try {
        res.json(await check());
      } catch (err) {
        res.status(500).json({ status: "down", detail: String(err) });
      }
    });
  }
}
