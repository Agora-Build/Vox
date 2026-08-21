// seed-data.ts — LOCAL DEVELOPMENT ONLY
//
// Purpose: convenience setup for local dev after a fresh DB reset.
// Called automatically by: ./scripts/dev-local-run.sh (start + reset commands)
//
// NOT needed for production. /api/auth/init already handles:
//   - Admin user creation
//   - Scout user creation (disabled, no password)
//   - All default providers (Agora ConvoAI Engine, LiveKit Agents, ElevenLabs Agents)
//   - All 5 pricing config tiers
//
// What this script adds on top of init (local dev only):
//   - Enables Scout account + sets known password (scout123) + email (scout@vox.ai)
//   - Creates Scout's mainline LiveKit evaluation workflow + eval set + schedule
//   - Creates Scout's Agora ConvoAI login workflow (mode: account) + short login-smoke eval set
//   - Seeds Protected login secrets AGORA_CONSOLE_EMAIL/PASSWORD from .env.dev (if set)
//
// Do not add production bootstrap logic here. If you need data in production,
// either add it to /api/auth/init or run a one-off migration.

import { DatabaseStorage, encryptValue } from "../server/storage";
import { hashPassword } from "../server/auth";
import type { InsertRegionLocation } from "../shared/schema";

async function seedData() {
  const storage = new DatabaseStorage();

  // Update Scout user (created by init) to be enabled with password and principal plan
  let scoutId: number;
  const existingScout = await storage.getUserByUsername("Scout");
  if (existingScout) {
    // Update existing Scout user created by init - ensure principal plan
    const passwordHash = await hashPassword("scout123");
    await storage.updateUser(existingScout.id, {
      email: "scout@vox.ai",
      passwordHash,
      plan: "principal",  // Ensure Scout has principal plan for mainline access
      isEnabled: true,
      emailVerifiedAt: new Date(),
    });
    scoutId = existingScout.id;
    console.log(`Scout user updated: ID ${existingScout.id} (plan: principal)`);
  } else {
    // Create Scout if not exists
    const passwordHash = await hashPassword("scout123");
    const scout = await storage.createUser({
      username: "Scout",
      email: "scout@vox.ai",
      passwordHash,
      plan: "principal",
      isAdmin: false,
      isEnabled: true,
      emailVerifiedAt: new Date(),
    });
    scoutId = scout.id;
    console.log(`Scout user created: ID ${scout.id} (plan: principal)`);
  }
  
  // Create providers
  const providers = await storage.getAllProviders();
  if (providers.length === 0) {
    const agoraProvider = await storage.createProvider({
      name: "Agora ConvoAI Engine",
      sku: "convoai",
      brandColor: "#099DFD",
      platformId: "agora",
    });
    console.log(`Provider created: ${agoraProvider.name} (ID: ${agoraProvider.id})`);

    const livekitProvider = await storage.createProvider({
      name: "LiveKit Agents",
      sku: "convoai",
      brandColor: "#1FD5F9",
      platformId: "livekit",
    });
    console.log(`Provider created: ${livekitProvider.name} (ID: ${livekitProvider.id})`);

    const elevenProvider = await storage.createProvider({
      name: "ElevenLabs Agents",
      sku: "convoai",
      brandColor: "#A8A29E",
      platformId: "elevenlabs",
    });
    console.log(`Provider created: ${elevenProvider.name} (ID: ${elevenProvider.id})`);

    const customProvider = await storage.createProvider({
      name: "Custom",
      sku: "convoai",
    });
    console.log(`Provider created: ${customProvider.name} (ID: ${customProvider.id})`);
  } else {
    console.log(`Providers already exist: ${providers.length} found`);
  }
  
  // Create default pricing config (prices in cents)
  const pricingConfigs = await storage.getAllPricingConfig();
  if (pricingConfigs.length === 0) {
    await storage.setPricingConfig({
      name: "Solo Premium",
      pricePerSeat: 500,
      minSeats: 1,
      maxSeats: 1,
      discountPercent: 0,
      isActive: true,
    });
    console.log("Created Solo Premium pricing config ($5/mo)");
    
    await storage.setPricingConfig({
      name: "Org Premium (1-2 seats)",
      pricePerSeat: 600,
      minSeats: 1,
      maxSeats: 2,
      discountPercent: 0,
      isActive: true,
    });
    console.log("Created Org Premium (1-2 seats) pricing config ($6/mo, no discount)");
    
    await storage.setPricingConfig({
      name: "Org Premium (3-5 seats)",
      pricePerSeat: 600,
      minSeats: 3,
      maxSeats: 5,
      discountPercent: 10,
      isActive: true,
    });
    console.log("Created Org Premium (3-5 seats) pricing config ($6/mo, 10% off)");
    
    await storage.setPricingConfig({
      name: "Org Premium (6-10 seats)",
      pricePerSeat: 600,
      minSeats: 6,
      maxSeats: 10,
      discountPercent: 15,
      isActive: true,
    });
    console.log("Created Org Premium (6-10 seats) pricing config ($6/mo, 15% off)");
    
    await storage.setPricingConfig({
      name: "Org Premium (11+ seats)",
      pricePerSeat: 600,
      minSeats: 11,
      maxSeats: 9999,
      discountPercent: 25,
      isActive: true,
    });
    console.log("Created Org Premium (11+ seats) pricing config ($6/mo, 25% off)");
  } else {
    console.log(`Pricing configs already exist: ${pricingConfigs.length} found`);
  }

  // Seed region-location bases (mirror of migration 0023_region_locations.sql).
  //
  // Why this is needed for local dev: `dev-local-run.sh reset` uses `db:push`
  // (schema-only sync), which recreates table structure but never executes any
  // migration's INSERT body — so region_locations is empty after a reset. Eval
  // agent token creation resolves `regionLocationBaseId` against this table, so
  // an empty table breaks any test/flow that registers an agent by region base.
  //
  // Idempotent per base (skip if it already exists). next_sequence must match
  // migration 0023 — the pre-allocated `<base>-01` site IDs the tests use
  // (e.g. na-us-seattle-01) rely on next_sequence >= 2. insertRegionLocationSchema
  // omits nextSequence (defaults to 1), so we bump it via updateRegionLocation.
  const regionBases: Array<{ base: InsertRegionLocation; nextSequence: number }> = [
    { base: { baseId: "na-us-seattle", displayName: "Seattle", city: "Seattle", countryCode: "US", countryName: "United States", macroRegionCode: "na", macroRegionName: "North America", isActive: true }, nextSequence: 2 },
    { base: { baseId: "apac-sg", displayName: "Singapore", city: "Singapore", countryCode: "SG", countryName: "Singapore", macroRegionCode: "apac", macroRegionName: "Asia Pacific", isActive: true }, nextSequence: 2 },
    { base: { baseId: "apac-in-mumbai", displayName: "Mumbai", city: "Mumbai", countryCode: "IN", countryName: "India", macroRegionCode: "apac", macroRegionName: "Asia Pacific", isActive: true }, nextSequence: 1 },
    { base: { baseId: "eu-de-frankfurt", displayName: "Frankfurt", city: "Frankfurt", countryCode: "DE", countryName: "Germany", macroRegionCode: "eu", macroRegionName: "Europe", isActive: true }, nextSequence: 2 },
    { base: { baseId: "sa-br-saopaulo", displayName: "Sao Paulo", city: "Sao Paulo", countryCode: "BR", countryName: "Brazil", macroRegionCode: "sa", macroRegionName: "South America", isActive: true }, nextSequence: 2 },
  ];
  for (const { base, nextSequence } of regionBases) {
    const existing = await storage.getRegionLocationByBaseId(base.baseId);
    if (existing) {
      console.log(`Region base already exists: ${base.baseId}`);
      continue;
    }
    const created = await storage.createRegionLocation(base);
    if (nextSequence > 1) {
      await storage.updateRegionLocation(created.id, { nextSequence });
    }
    console.log(`Created region base: ${base.baseId} (next_sequence: ${nextSequence})`);
  }

  // Create Scout's LiveKit evaluation workflow and schedule
  // This sets up a mainline workflow that runs every 8 hours
  const scoutWorkflows = await storage.getWorkflowsByOwner(scoutId);
  const existingLiveKitWorkflow = scoutWorkflows.find(w => w.name === "LiveKit Agent Evaluation");

  if (!existingLiveKitWorkflow) {
    // Get LiveKit provider
    const allProviders = await storage.getAllProviders();
    const livekitProvider = allProviders.find(p => p.name.includes("LiveKit"));
    const agoraProvider = allProviders.find(p => p.name.includes("Agora"));

    // Create project for Scout
    let scoutProject = (await storage.getProjectsByOwner(scoutId))[0];
    if (!scoutProject) {
      scoutProject = await storage.createProject({
        name: "Scout Evaluations",
        description: "Official evaluation project for voice AI agents",
        ownerId: scoutId,
      });
      console.log(`Created Scout project: ${scoutProject.name}`);
    }

    // Requires the 'three_questions_en' corpus to exist in aeval-data/ at runtime.
    // Shared eval-set body (provider-agnostic): a minimal aeval scenario with
    // analysis + steps, NO platform setup. Inline YAML content (not a filename).
    const sharedScenarioBody = `name: basic_conversation
description: Standard conversation latency body
analysis:
  preset: config/analysis_presets/default.yaml
params:
  output_dir: temp/output
steps:
  - type: audio.wait_for_speech
    timeout_ms: 30000
    silence_duration_ms: 1500
    description: Wait for agent greeting
  - type: control.for_each
    corpus_set: three_questions_en
    steps:
      - type: audio.play
        corpus_id: \${item}
        description: Play question (response latency test)
      - type: audio.wait_for_speech
        end_timeout_ms: 45000
        silence_duration_ms: 1000
        description: Wait for full agent response
`;

    // LiveKit workflow: platform enter/exit only (no login).
    const livekitWorkflow = await storage.createWorkflow({
      name: "LiveKit Agent Evaluation",
      description: "Mainline evaluation workflow for LiveKit Agents - runs every 8 hours",
      ownerId: scoutId,
      projectId: scoutProject.id,
      providerId: livekitProvider?.id || null,
      visibility: "public",
      isMainline: true,
      config: {
        framework: "aeval",
        stepsPrefix: `- type: platform.setup
  platform_id: livekit
  params:
    mode: public
- type: audio.start_recording
- type: platform.enter
  params:
    tone_name: ''`,
        // Same teardown for all aeval workflows (stop recording, leave platform).
        stepsSuffix: `- type: audio.stop_recording
- type: platform.exit`,
      },
    });
    console.log(`Created LiveKit workflow: ${livekitWorkflow.name} (mainline: true)`);

    // Agora workflow: real SSO login BEFORE enter — the `mode: account` flow
    // matches config/platforms/agora.yaml's `setup:account`. Both email and
    // password come from Protected (login-class) secrets, so Core mints a
    // storageState via the session broker and the agent never sees them.
    // Mirrors scenarios/smoke_test_en_agora.yaml + examples/agora-agents.yaml.
    const agoraWorkflow = await storage.createWorkflow({
      name: "Agora ConvoAI Evaluation",
      description: "Evaluation workflow for Agora ConvoAI - Console login (mode: account) before joining",
      ownerId: scoutId,
      projectId: scoutProject.id,
      providerId: agoraProvider?.id || null,
      visibility: "public",
      isMainline: false,
      config: {
        framework: "aeval",
        stepsPrefix: `- type: platform.setup
  platform_id: agora
  params:
    mode: account
    email: \${secrets.AGORA_CONSOLE_EMAIL}
    password: \${secrets.AGORA_CONSOLE_PASSWORD}
- type: audio.start_recording
- type: platform.enter
  params:
    tone_name: ''
- type: platform.wait_for_active
- type: audio.wait_for_speech
  timeout_ms: 30000
  silence_duration_ms: 1500
  description: Wait for agent greeting`,
        // Same teardown for all aeval workflows (stop recording, leave platform).
        stepsSuffix: `- type: audio.stop_recording
- type: platform.exit`,
      },
    });
    console.log(`Created Agora workflow: ${agoraWorkflow.name}`);

    // Shared eval set (body only) — referenced by both workflows.
    const scoutEvalSets = await storage.getEvalSetsByOwner(scoutId);
    let basicEvalSet = scoutEvalSets.find(e => e.name === "Basic Conversation Test");
    if (!basicEvalSet) {
      basicEvalSet = await storage.createEvalSet({
        name: "Basic Conversation Test",
        description: "Standard conversation evaluation for voice AI latency testing",
        ownerId: scoutId,
        visibility: "public",
        isMainline: true,
        config: {
          scenario: sharedScenarioBody,
        },
      });
      console.log(`Created eval set: ${basicEvalSet.name}`);
    }

    // Short single-turn eval set for the Agora login e2e — one prompt, one
    // response. Deliberately minimal so the login → mint → conversation chain
    // can be exercised end-to-end quickly (mirrors examples/agora-agents.yaml).
    let loginSmokeEvalSet = scoutEvalSets.find(e => e.name === "Agora Login Smoke");
    if (!loginSmokeEvalSet) {
      loginSmokeEvalSet = await storage.createEvalSet({
        name: "Agora Login Smoke",
        description: "Minimal single-turn body for the Agora Console login e2e",
        ownerId: scoutId,
        visibility: "public",
        isMainline: false,
        config: {
          scenario: `name: agora_login_smoke
description: Minimal single-turn body for the Agora login e2e
analysis:
  preset: config/analysis_presets/default.yaml
params:
  output_dir: temp/output
steps:
  - type: audio.play
    file: examples/multi_turn_dialogue/audio/1_paris.mp3
    description: Play one user prompt
  - type: audio.wait_for_speech
    start_timeout_ms: 30000
    end_timeout_ms: 90000
    timeout_ms: 120000
    silence_duration_ms: 3000
    description: Wait for agent response
`,
        },
      });
      console.log(`Created eval set: ${loginSmokeEvalSet.name}`);
    }

    // Create recurring schedule - every 8 hours (at 0:00, 8:00, 16:00)
    // Cron: "0 */8 * * *" means "at minute 0 past every 8th hour"
    const schedules = await storage.getEvalSchedulesByWorkflow(livekitWorkflow.id);
    if (schedules.length === 0) {
      // Calculate next run time for every 8 hours
      const now = new Date();
      const nextHour = Math.ceil(now.getHours() / 8) * 8;
      const nextRunAt = new Date(now);
      nextRunAt.setHours(nextHour % 24, 0, 0, 0);
      if (nextRunAt <= now) {
        nextRunAt.setHours(nextRunAt.getHours() + 8);
      }

      const schedule = await storage.createEvalSchedule({
        name: "LiveKit 8-Hour Evaluation",
        workflowId: livekitWorkflow.id,
        evalSetId: basicEvalSet.id,
        region: "na",  // North America region
        scheduleType: "recurring",
        cronExpression: "0 */8 * * *",  // Every 8 hours
        timezone: "UTC",
        isEnabled: true,
        nextRunAt: nextRunAt,
        maxRuns: null,  // Unlimited runs
        createdBy: scoutId,
      });
      console.log(`Created recurring schedule: ${schedule.name} (every 8 hours, region: NA)`);
      console.log(`  Next run at: ${nextRunAt.toISOString()}`);
    } else {
      console.log(`Schedule already exists for LiveKit workflow`);
    }
  } else {
    console.log(`LiveKit workflow already exists: ID ${existingLiveKitWorkflow.id}`);
  }

  // Agora Console login credentials (Protected / login-class) for the login
  // e2e. Sourced from the environment (.env.dev on the host, gitignored) so
  // real credentials are NEVER committed. Re-run on every seed (outside the
  // workflow guard) so an updated .env.dev value propagates after a reset.
  // Owned by Scout to match the Agora workflow's ownership — a personal
  // workflow spends its owner's personal secrets. `class: protected` makes
  // them Core-only: structurally withheld from the agent, minted via broker.
  const agoraEmail = process.env.AGORA_CONSOLE_EMAIL;
  const agoraPassword = process.env.AGORA_CONSOLE_PASSWORD;
  if (agoraEmail && agoraPassword) {
    await storage.createOrUpdateSecret(
      scoutId, "AGORA_CONSOLE_EMAIL", encryptValue(agoraEmail), { class: "protected" });
    await storage.createOrUpdateSecret(
      scoutId, "AGORA_CONSOLE_PASSWORD", encryptValue(agoraPassword), { class: "protected" });
    console.log("Seeded Protected secrets: AGORA_CONSOLE_EMAIL, AGORA_CONSOLE_PASSWORD (login-class, Scout-owned)");
  } else {
    console.log("Skipped Agora login secrets (set AGORA_CONSOLE_EMAIL / AGORA_CONSOLE_PASSWORD in .env.dev to enable the login e2e)");
  }

  console.log("\nSeed data complete!");
  process.exit(0);
}

seedData().catch((error) => {
  console.error("Error seeding data:", error);
  process.exit(1);
});
