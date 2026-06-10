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
//   - Creates Scout's Agora ConvoAI evaluation workflow (same eval set, authenticated setup)
//
// Do not add production bootstrap logic here. If you need data in production,
// either add it to /api/auth/init or run a one-off migration.

import { DatabaseStorage } from "../server/storage";
import { hashPassword } from "../server/auth";

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
    });
    console.log(`Provider created: ${agoraProvider.name} (ID: ${agoraProvider.id})`);

    const livekitProvider = await storage.createProvider({
      name: "LiveKit Agents",
      sku: "convoai",
      brandColor: "#1FD5F9",
    });
    console.log(`Provider created: ${livekitProvider.name} (ID: ${livekitProvider.id})`);

    const elevenProvider = await storage.createProvider({
      name: "ElevenLabs Agents",
      sku: "convoai",
      brandColor: "#A8A29E",
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

    // Agora workflow: login/auth BEFORE enter — demonstrates provider-specific setup.
    const agoraWorkflow = await storage.createWorkflow({
      name: "Agora ConvoAI Evaluation",
      description: "Evaluation workflow for Agora ConvoAI - login required before joining",
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
    mode: authenticated
- type: platform.login
  params:
    token: \${secrets.agora_token}
- type: audio.start_recording
- type: platform.enter
  params:
    tone_name: ''`,
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

  console.log("\nSeed data complete!");
  process.exit(0);
}

seedData().catch((error) => {
  console.error("Error seeding data:", error);
  process.exit(1);
});
