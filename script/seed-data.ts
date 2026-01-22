import { DatabaseStorage } from "../server/storage";
import { hashPassword } from "../server/auth";

async function seedData() {
  const storage = new DatabaseStorage();

  // Update Scout user (created by init) to be enabled with password
  const existingScout = await storage.getUserByUsername("Scout");
  if (existingScout) {
    // Update existing Scout user created by init
    const passwordHash = await hashPassword("scout123");
    await storage.updateUser(existingScout.id, {
      email: "scout@vox.ai",
      passwordHash,
      isEnabled: true,
      emailVerifiedAt: new Date(),
    });
    console.log(`Scout user updated: ID ${existingScout.id}`);
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
    console.log(`Scout user created: ID ${scout.id}`);
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
  
  console.log("\nSeed data complete!");
  process.exit(0);
}

seedData().catch((error) => {
  console.error("Error seeding data:", error);
  process.exit(1);
});
