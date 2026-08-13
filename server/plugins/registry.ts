import semver from "semver";

interface Entry { version: string; impl: unknown; }

export class ServiceRegistry {
  private services = new Map<string, Entry>();

  provide(name: string, version: string, impl: unknown): void {
    if (this.services.has(name)) {
      throw new Error(`duplicate singleton provider for service ${name}`);
    }
    if (!semver.valid(version)) {
      throw new Error(`invalid version ${version} for service ${name}`);
    }
    this.services.set(name, { version, impl });
  }

  optional<T>(name: string, range: string): T | null {
    const entry = this.services.get(name);
    if (!entry) return null;
    if (!semver.satisfies(entry.version, range)) {
      throw new Error(`service ${name}@${entry.version} does not satisfy ${range}`);
    }
    return entry.impl as T;
  }

  require<T>(name: string, range: string): T {
    const svc = this.optional<T>(name, range);
    if (svc === null) {
      throw new Error(`required service ${name}@${range} not available`);
    }
    return svc;
  }
}
