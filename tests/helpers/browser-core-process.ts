// A real, independent Core process for the multi-replica integration test.
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { createServer } from "node:http";
import { pool } from "../../server/storage";
import { Pool } from "pg";
import { createPluginDb } from "../../server/plugins/db";
import { createOrganizationsProvider } from "../../plugins/organizations/server/provider";
import { setOrganizations } from "../../server/organizations";

async function main() {
  const orgPool = process.env.TEST_BROWSER_ORG_SCHEMA ? new Pool({ connectionString: process.env.TEST_PLUGIN_DATABASE_URL }) : null;
  if (orgPool) setOrganizations(createOrganizationsProvider(createPluginDb(orgPool, process.env.TEST_BROWSER_ORG_SCHEMA!)));
  const app = express(), server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.VOX_CORE_INTERNAL_URL = origin;
  const { coreRouting } = await import("../../server/core-routing-runtime");
  const { setupBrowserAgentBridge } = await import("../../server/browser-agent-bridge");
  const { registerBrowserAssistanceRoutes } = await import("../../server/routes-browser-assistance");
  const { publishBrokerMintSecret, getBrokerTarget, mintViaBroker } = await import("../../server/broker-registry");
  const { storage } = await import("../../server/storage");
  coreRouting.register(app);
  app.use(express.json());
  const Store = connectPgSimple(session);
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false,
    store: new Store({ pool, tableName: "user_sessions" }), cookie: { httpOnly: true, sameSite: "lax" } }));
  // Test-only login/registration seams; never imported by the production server.
  app.post("/test/login", (req, res) => { req.session.userId = Number(req.body.userId); res.json({ ok: true }); });
  app.post("/test/broker", async (req, res) => {
    await publishBrokerMintSecret(req.body.id, req.body.leaseId, req.body.secret); res.json({ ok: true });
  });
  app.get("/test/broker/:id", async (req, res) => {
    const broker = await storage.getBroker(Number(req.params.id));
    res.json({ available: !!broker && !!await getBrokerTarget(broker) });
  });
  app.post("/test/broker/:id/mint", async (req, res) => {
    const broker = await storage.getBroker(Number(req.params.id));
    const target = broker && await getBrokerTarget(broker);
    if (!target) return res.sendStatus(503);
    res.json({ storageState: await mintViaBroker(target, req.body) });
  });
  registerBrowserAssistanceRoutes(app); setupBrowserAgentBridge(server); coreRouting.start();
  const stop = async () => { await coreRouting.stop(); server.closeAllConnections(); server.close(); await pool.end(); await orgPool?.end(); process.exit(0); };
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  process.stdout.write(`ROUTING_READY ${JSON.stringify({ origin, id: coreRouting.id })}\n`);
}
void main().catch(() => process.exit(1));
