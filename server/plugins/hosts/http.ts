import express, { type Express, type NextFunction, type Request, type Response, type Router } from "express";
import type { Handler, RouteRegistrar } from "@vox/plugin-sdk";
import { requireAuth, requireAdmin } from "../../auth";

type Method = "get" | "post" | "patch" | "delete";

// Express 4 does not catch rejected promises from async handlers — an unhandled
// rejection from a plugin route would otherwise crash the whole process. This is
// the single choke-point where every plugin route handler gets mounted, so wrap
// each one here rather than relying on individual plugins to do it themselves.
function asyncSafe(pluginId: string, handler: Handler): Handler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch((err: unknown) => {
      console.error(
        `[plugin:${pluginId}] route error on ${req.method} ${req.path}:`,
        err instanceof Error ? err.message : err,
      );
      if (!res.headersSent) res.status(500).json({ error: "Internal plugin error" });
    });
  };
}

export class HttpHost {
  private taken = new Set<string>();
  private routers = new Map<string, Router>();

  createRegistrar(pluginId: string): RouteRegistrar {
    const router = express.Router();
    this.routers.set(pluginId, router);

    const add = (method: Method) => (path: string, ...handlers: Handler[]): void => {
      const key = `${method.toUpperCase()} /api/plugins/${pluginId}${path}`;
      if (this.taken.has(key)) throw new Error(`route conflict: ${key}`);
      this.taken.add(key);
      router[method](path, ...handlers.map((h) => asyncSafe(pluginId, h)));
    };

    return {
      get: add("get"),
      post: add("post"),
      patch: add("patch"),
      delete: add("delete"),
      requireAuth,
      requireAdmin,
    };
  }

  mount(app: Express): void {
    this.routers.forEach((router, id) => {
      app.use(`/api/plugins/${id}`, router);
    });
  }
}
