import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { parseManifest } from "../server/plugins/manifest";

export function validatePlugin(dir: string): string[] {
  const errors: string[] = [];
  const manifestPath = `${dir}/vox.plugin.json`;
  if (!existsSync(manifestPath)) return [`${dir}: missing vox.plugin.json`];

  let manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf-8")));
  } catch (err) {
    return [`${dir}: ${String(err)}`];
  }

  const specPath = `${dir}/SPEC.md`;
  if (!existsSync(specPath)) return [`${dir}: missing SPEC.md`];
  const spec = readFileSync(specPath, "utf-8");

  for (const route of manifest.routes) {
    if (!spec.includes(route)) errors.push(`${manifest.id}: route "${route}" not documented in SPEC.md`);
  }
  for (const svc of Object.keys(manifest.providesServices)) {
    if (!spec.includes(svc)) errors.push(`${manifest.id}: provided service "${svc}" not documented in SPEC.md`);
  }
  for (const svc of Object.keys(manifest.requiresServices)) {
    if (!spec.includes(svc)) errors.push(`${manifest.id}: required service "${svc}" not documented in SPEC.md`);
  }
  return errors;
}

function main(): void {
  const root = "plugins";
  if (!existsSync(root)) { console.log("no plugins/ directory — nothing to validate"); return; }
  const dirs = readdirSync(root).filter((d) => {
    const p = `${root}/${d}`;
    return statSync(p).isDirectory() && existsSync(`${p}/vox.plugin.json`);
  });
  const allErrors = dirs.flatMap((d) => validatePlugin(`${root}/${d}`));
  if (allErrors.length > 0) {
    console.error("plugins:validate found drift:");
    for (const e of allErrors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(`plugins:validate: ${dirs.length} plugin(s) OK`);
}

// Run as CLI only (not when imported by tests).
import { fileURLToPath } from "url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
