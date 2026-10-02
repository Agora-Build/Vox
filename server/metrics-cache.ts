export class MetricsCache {
  private entries = new Map<string, { data: unknown; expiry: number }>();

  constructor(private maxEntries: number, private ttlMs = 30000) {}

  get<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiry <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set(key: string, data: unknown): void {
    const now = Date.now();
    for (const [cachedKey, entry] of Array.from(this.entries.entries())) {
      if (entry.expiry <= now) this.entries.delete(cachedKey);
    }
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { data, expiry: now + this.ttlMs });
  }
}
