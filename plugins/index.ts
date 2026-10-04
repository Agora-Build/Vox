import type { VoxPlugin } from "@vox/plugin-sdk";
import samplePlugin from "./sample/server/index";
import creditsPlugin from "./credits/server/index";
import sharedAgentsPlugin from "./shared-agents/server/index";
import organizationsPlugin from "./organizations/server/index";
import oauthPlugin from "./oauth/server/index";
import notificationsPlugin from "./notifications/server/index";
import paymentsPlugin from "./payments/server/index";

export const BUILTIN_PLUGINS: Record<string, VoxPlugin> = {
  sample: samplePlugin,
  credits: creditsPlugin,
  "shared-agents": sharedAgentsPlugin,
  organizations: organizationsPlugin,
  oauth: oauthPlugin,
  notifications: notificationsPlugin,
  payments: paymentsPlugin,
};
