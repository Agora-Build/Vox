import { DatabaseStorage } from "../server/storage";
import { hashPassword } from "../server/auth";

async function createAdmin() {
  const storage = new DatabaseStorage();
  
  const email = process.argv[2] || "brent@agora.io";
  const password = process.argv[3] || "1234567890";
  const username = process.argv[4] || "brent";
  
  // Check if user already exists
  const existingUser = await storage.getUserByEmail(email);
  if (existingUser) {
    console.log(`User with email ${email} already exists`);
    process.exit(0);
  }
  
  const passwordHash = await hashPassword(password);
  
  const admin = await storage.createUser({
    username,
    email,
    passwordHash,
    plan: "principal",
    isAdmin: true,
    isEnabled: true,
    emailVerifiedAt: new Date(),
  });
  
  console.log(`Admin user created successfully:`);
  console.log(`  ID: ${admin.id}`);
  console.log(`  Username: ${admin.username}`);
  console.log(`  Email: ${admin.email}`);
  console.log(`  Plan: ${admin.plan}`);
  console.log(`  Is Admin: ${admin.isAdmin}`);
  
  // Also mark system as initialized
  await storage.setConfig({ key: "system_initialized", value: "true" });
  console.log(`System marked as initialized`);
  
  process.exit(0);
}

createAdmin().catch((error) => {
  console.error("Error creating admin:", error);
  process.exit(1);
});
