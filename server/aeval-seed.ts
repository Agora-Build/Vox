/**
 * aeval-seed.ts — Auto-seed built-in workflows + eval sets when a new aeval version appears.
 *
 * Two trigger points:
 *   1. Server startup  → seedFromLocalAevalData() reads version from aeval-data/release/
 *   2. Daemon register → seedAevalVersion(version) called when agent reports frameworkVersion
 *
 * Idempotency is guaranteed by atomically claiming a systemConfig key `aeval_seeded:<version>`
 * via INSERT ON CONFLICT (prevents race conditions between concurrent triggers).
 */

import fs from "fs";
import path from "path";
import { storage, db } from "./storage";
import { systemConfig } from "@shared/schema";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioMeta {
  category: string;
  filename: string;
  name: string;
  description: string;
  yamlContent: string;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver-ish version strings (e.g. "v0.1.0", "0.2.1").
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Scenario discovery
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  response: "Response Tests",
  interrupt: "Interrupt Tests",
  multi_turn_dialogue: "Multi-Turn Dialogue Tests",
};

/**
 * Walk `aeval-data/examples/{category}/*.yaml` and return metadata for each.
 */
export function discoverScenarios(aevalDataPath: string): ScenarioMeta[] {
  const examplesDir = path.join(aevalDataPath, "examples");
  if (!fs.existsSync(examplesDir)) return [];

  const results: ScenarioMeta[] = [];

  for (const category of fs.readdirSync(examplesDir)) {
    const catDir = path.join(examplesDir, category);
    if (!fs.statSync(catDir).isDirectory()) continue;

    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;

      const yamlContent = fs.readFileSync(path.join(catDir, file), "utf-8");

      // Try to extract name/description from YAML front matter
      const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
      const descMatch = yamlContent.match(/^description:\s*(.+)$/m);

      results.push({
        category,
        filename: file,
        name: nameMatch?.[1]?.trim() || path.basename(file, path.extname(file)),
        description: descMatch?.[1]?.trim() || "",
        yamlContent,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

/**
 * Idempotent seed for a specific aeval version.
 * Creates a "[Built-in]" project, workflows per category, and eval sets per YAML.
 */
export async function seedAevalVersion(version: string, aevalDataPath?: string): Promise<void> {
  const configKey = `aeval_seeded:${version}`;

  // Atomic idempotency: INSERT ON CONFLICT prevents race between concurrent triggers
  // (server startup + agent registration can fire simultaneously)
  const claimed = await db
    .insert(systemConfig)
    .values({ key: configKey, value: "seeding" })
    .onConflictDoNothing({ target: systemConfig.key })
    .returning();

  if (claimed.length === 0) {
    // Another process already claimed (or completed) this version
    console.log(`[aeval-seed] Already seeded for ${version}, skipping`);
    return;
  }

  // Helper: release the lock on failure so future attempts can retry
  const releaseLock = async () => {
    try {
      await db.delete(systemConfig).where(sql`${systemConfig.key} = ${configKey}`);
    } catch (e) {
      console.error("[aeval-seed] Failed to release seed lock:", e);
    }
  };

  // Resolve aeval-data path (default: sibling of server/ → vox_eval_agentd/aeval-data)
  const dataPath =
    aevalDataPath ||
    path.resolve(__dirname, "..", "vox_eval_agentd", "aeval-data");

  const scenarios = discoverScenarios(dataPath);
  if (scenarios.length === 0) {
    console.log(`[aeval-seed] No scenarios found in ${dataPath}, releasing lock`);
    await releaseLock();
    return;
  }

  console.log(
    `[aeval-seed] Seeding built-in data for aeval ${version} (${scenarios.length} scenarios)...`,
  );

  // Find Scout user
  const scout = await storage.getUserByUsername("Scout");
  if (!scout) {
    console.error("[aeval-seed] Scout user not found — system not initialized, releasing lock");
    await releaseLock();
    return;
  }

  // Find "LiveKit Agents" provider
  const allProviders = await storage.getAllProviders();
  const livekitProvider = allProviders.find((p) => p.name.includes("LiveKit"));
  if (!livekitProvider) {
    console.error("[aeval-seed] LiveKit provider not found, releasing lock");
    await releaseLock();
    return;
  }

  try {
    // Create (or reuse) the built-in project
    const projectName = `[Built-in] aeval ${version} Tests`;
    const existingProjects = await storage.getProjectsByOwner(scout.id);
    let project = existingProjects.find((p) => p.name === projectName);
    if (!project) {
      project = await storage.createProject({
        name: projectName,
        description: `Auto-seeded test data from aeval ${version}`,
        ownerId: scout.id,
      });
      console.log(`[aeval-seed] Created project: ${projectName} (id=${project.id})`);
    }

    // Group scenarios by category
    const byCategory = new Map<string, ScenarioMeta[]>();
    for (const s of scenarios) {
      const arr = byCategory.get(s.category) || [];
      arr.push(s);
      byCategory.set(s.category, arr);
    }

    // Pre-fetch existing workflows and eval sets once to avoid per-iteration DB queries
    const existingWorkflows = await storage.getWorkflowsByProject(project.id);
    const existingEvalSets = await storage.getEvalSetsByOwner(scout.id);
    const existingEvalSetNames = new Set(existingEvalSets.map((es) => es.name));
    const existingWorkflowNames = new Set(existingWorkflows.map((w) => w.name));

    for (const [category, catScenarios] of Array.from(byCategory.entries())) {
      const label = CATEGORY_LABELS[category] || category;
      const workflowName = `[aeval ${version}] ${label}`;

      // Create workflow for this category (skip if already exists)
      let workflow = existingWorkflows.find((w) => w.name === workflowName);
      if (!workflow && !existingWorkflowNames.has(workflowName)) {
        workflow = await storage.createWorkflow({
          name: workflowName,
          description: `Built-in ${label.toLowerCase()} from aeval ${version}`,
          projectId: project.id,
          providerId: livekitProvider.id,
          ownerId: scout.id,
          visibility: "public",
          isMainline: false,
          config: { framework: "aeval", frameworkVersion: version },
        });
        console.log(`[aeval-seed]   Workflow: ${workflowName} (id=${workflow.id})`);
      }

      // Create eval sets for each scenario
      for (const scenario of catScenarios) {
        const evalSetName = `[aeval ${version}] ${scenario.name}`;

        if (existingEvalSetNames.has(evalSetName)) continue;

        await storage.createEvalSet({
          name: evalSetName,
          description: scenario.description,
          ownerId: scout.id,
          visibility: "public",
          isMainline: false,
          config: {
            framework: "aeval",
            frameworkVersion: version,
            builtIn: true,
            scenario: scenario.yamlContent,
          },
        });
        existingEvalSetNames.add(evalSetName); // track newly created
        console.log(`[aeval-seed]     Eval set: ${evalSetName}`);
      }
    }

    // Mark as complete (update the "seeding" value to "true")
    await storage.setConfig({ key: configKey, value: "true" });
    console.log(`[aeval-seed] Done seeding aeval ${version}`);
  } catch (error) {
    console.error(`[aeval-seed] Seeding failed for ${version}, releasing lock:`, error);
    await releaseLock();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Startup trigger
// ---------------------------------------------------------------------------

/**
 * Detect local aeval version from aeval-data/release/LATEST_RELEASE_NOTES.md
 * and seed if not already done.
 */
export async function seedFromLocalAevalData(): Promise<void> {
  const aevalDataPath = path.resolve(
    __dirname,
    "..",
    "vox_eval_agentd",
    "aeval-data",
  );

  if (!fs.existsSync(aevalDataPath)) {
    console.log("[aeval-seed] No aeval-data directory found, skipping startup seed");
    return;
  }

  const releaseNotes = path.join(
    aevalDataPath,
    "release",
    "LATEST_RELEASE_NOTES.md",
  );

  if (!fs.existsSync(releaseNotes)) {
    console.log("[aeval-seed] No LATEST_RELEASE_NOTES.md found, skipping");
    return;
  }

  const content = fs.readFileSync(releaseNotes, "utf-8");
  // Extract version from first line: "# aeval v0.1.0"
  const match = content.match(/^#\s+aeval\s+(v[\d.]+)/m);
  if (!match) {
    console.log("[aeval-seed] Could not parse version from release notes, skipping");
    return;
  }

  const version = match[1];
  await seedAevalVersion(version, aevalDataPath);
}
