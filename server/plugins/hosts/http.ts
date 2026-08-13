import express, { type Express, type Router } from "express";
import type { Handler, RouteRegistrar } from "@vox/plugin-sdk";
import { requireAuth, requireAdmin } from "../../auth";

type Method = "get" | "post" | "patch" | "delete";

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
      router[method](path, ...handlers);
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
