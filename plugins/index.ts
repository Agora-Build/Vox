import type { VoxPlugin } from "@vox/plugin-sdk";
import samplePlugin from "./sample/server/index";

export const BUILTIN_PLUGINS: Record<string, VoxPlugin> = {
  sample: samplePlugin,
};
