import { z } from "zod";
import semver from "semver";

const semverString = z.string().refine((v) => semver.valid(v) !== null, "must be a valid semver version");
const serviceMap = z.record(z.string(), semverString).default({});

const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
    version: semverString,
    voxPluginApi: z.string().refine((v) => semver.validRange(v) !== null, "must be a valid semver range"),
    providesServices: serviceMap,
    requiresServices: z.record(z.string(), z.string()).default({}),
    optionalServices: z.record(z.string(), z.string()).default({}),
    migrations: z.string().optional(),
    routes: z.array(z.string()).default([]),
  })
  .strict();

export type PluginManifest = z.infer<typeof manifestSchema>;

export function parseManifest(raw: unknown): PluginManifest {
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid plugin manifest: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}
