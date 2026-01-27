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
    });
    console.log(`Provider created: ${agoraProvider.name} (ID: ${agoraProvider.id})`);
    
    const livekitProvider = await storage.createProvider({
      name: "LiveKit Agents",
      sku: "convoai",
    });
    console.log(`Provider created: ${livekitProvider.name} (ID: ${livekitProvider.id})`);
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

    // Create LiveKit evaluation workflow
    const livekitWorkflow = await storage.createWorkflow({
      name: "LiveKit Agent Evaluation",
      description: "Mainline evaluation workflow for LiveKit Agents - runs every 8 hours",
      ownerId: scoutId,
      projectId: scoutProject.id,
      providerId: livekitProvider?.id || null,
      visibility: "public",
      isMainline: true,  // Mark as mainline for leaderboard
      config: {
        application: "livekit.yaml",
        scenario: "basic_conversation.yaml",
      },
    });
    console.log(`Created LiveKit workflow: ${livekitWorkflow.name} (mainline: true)`);

    // Create eval set for basic conversation testing
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
          scenario: "basic_conversation.yaml",
          turns: 5,
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
