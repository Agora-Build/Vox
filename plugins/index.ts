import type { VoxPlugin } from "@vox/plugin-sdk";
import samplePlugin from "./sample/server/index";
import creditsPlugin from "./credits/server/index";
import sharedAgentsPlugin from "./shared-agents/server/index";

export const BUILTIN_PLUGINS: Record<string, VoxPlugin> = {
  sample: samplePlugin,
  credits: creditsPlugin,
  "shared-agents": sharedAgentsPlugin,
};
