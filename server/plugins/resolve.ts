import type { PluginManifest } from "./manifest";

export function resolveActivationOrder(manifests: PluginManifest[]): PluginManifest[] {
  const providers = new Map<string, string>(); // service name -> plugin id
  for (const m of manifests) {
    for (const svc of Object.keys(m.providesServices)) {
      const existing = providers.get(svc);
      if (existing) {
        throw new Error(`duplicate singleton provider for ${svc}: ${existing} and ${m.id}`);
      }
      providers.set(svc, m.id);
    }
  }

  const byId = new Map(manifests.map((m) => [m.id, m]));
  const deps = new Map<string, string[]>();
  for (const m of manifests) {
    const d: string[] = [];
    for (const svc of Object.keys(m.requiresServices)) {
      const provider = providers.get(svc);
      if (!provider) {
        throw new Error(`plugin ${m.id} requires service ${svc} but no enabled plugin provides it`);
      }
      if (provider !== m.id) d.push(provider);
    }
    for (const svc of Object.keys(m.optionalServices)) {
      const provider = providers.get(svc);
      if (provider && provider !== m.id) d.push(provider);
    }
    deps.set(m.id, d);
  }

  const order: PluginManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      throw new Error(`dependency cycle: ${[...stack, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) visit(dep, [...stack, id]);
    state.set(id, "done");
    order.push(byId.get(id)!);
  };
  for (const m of manifests) visit(m.id, []);
  return order;
}
