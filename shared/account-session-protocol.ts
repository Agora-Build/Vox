import { z } from "zod";

export const ACCOUNT_STATE_FORMAT = "playwright.cookies-localstorage.v1";
export const ACCOUNT_CHECKPOINT_LIMITS = Object.freeze({
  snapshotBytes: 2 * 1024 * 1024,
  pendingSnapshots: 32,
  pendingBytes: 16 * 1024 * 1024,
  readyRecords: 1024,
  recordBytes: 4096,
  pendingMs: 10 * 60 * 1000,
  finalFlushMs: 5000,
});
export const engineSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const accountCheckpointSchema = z.object({
  schema: z.literal("auth.checkpoint.v3"),
  session_id: engineSessionIdSchema,
  snapshot_id: z.string().regex(/^[a-f0-9]{32}$/),
  sequence: z.number().int().positive().max(9_999_999_999),
  snapshot: z.string(),
  storage_format: z.literal(ACCOUNT_STATE_FORMAT),
  byte_length: z.number().int().positive().max(ACCOUNT_CHECKPOINT_LIMITS.snapshotBytes),
}).strict();
export type AccountCheckpointRecord = z.infer<typeof accountCheckpointSchema>;

export class AccountCheckpointError extends Error {
  constructor(public readonly code: "invalid-record" | "invalid-state" | "unsafe-path" | "capacity" | "lock-unavailable") {
    super(`Account checkpoint: ${code}`);
    this.name = "AccountCheckpointError";
  }
}

/** JSON.parse alone silently accepts duplicate keys, including escaped aliases. */
export function parseAccountJson(text: string): unknown {
  try {
    const result: unknown = JSON.parse(text);
    let position = 0;
    const whitespace = () => { while (/\s/.test(text[position] ?? "") && position < text.length) position++; };
    const string = (): string => {
      const start = position++;
      while (position < text.length) {
        const char = text[position++];
        if (char === "\\") position++;
        else if (char === '"') return JSON.parse(text.slice(start, position)) as string;
      }
      throw new Error();
    };
    const value = (depth: number): void => {
      if (depth > 64) throw new Error();
      whitespace();
      if (text[position] === '"') { string(); return; }
      if (text[position] === "{" || text[position] === "[") {
        const object = text[position++] === "{";
        const end = object ? "}" : "]";
        const keys = new Set<string>();
        whitespace();
        if (text[position] === end) { position++; return; }
        for (;;) {
          if (object) {
            whitespace();
            const key = string();
            if (keys.has(key)) throw new Error();
            keys.add(key);
            whitespace(); position++; // JSON.parse already verified the colon/grammar.
          }
          value(depth + 1); whitespace();
          if (text[position++] === end) return;
        }
      }
      while (position < text.length && !/[\s,\]}]/.test(text[position])) position++;
    };
    value(0);
    return result;
  } catch { throw new AccountCheckpointError("invalid-state"); }
}

export function parseAccountCheckpoint(text: string, expectedSessionId: string, filename: string): AccountCheckpointRecord {
  try {
    engineSessionIdSchema.parse(expectedSessionId);
    const record = accountCheckpointSchema.parse(parseAccountJson(text));
    if (record.session_id !== expectedSessionId ||
        record.snapshot !== `snapshots/${expectedSessionId}/${record.snapshot_id}.json` ||
        filename !== `${String(record.sequence).padStart(10, "0")}-${record.snapshot_id}.json`) throw new Error();
    return record;
  } catch { throw new AccountCheckpointError("invalid-record"); }
}

const cookieSchema = z.object({
  name: z.string().min(1), value: z.string(), domain: z.string().min(1), path: z.string().startsWith("/"),
  expires: z.number().finite().refine(n => n === -1 || n >= 0), httpOnly: z.boolean(),
  secure: z.literal(true), sameSite: z.enum(["Strict", "Lax", "None"]),
}).strict();
const stateSchema = z.object({
  cookies: z.array(cookieSchema),
  origins: z.array(z.object({
    origin: z.string(), localStorage: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
  }).strict()),
}).strict();

/** Scope comes from a reviewed provider binding, never from uploaded state. */
export function acceptsAccountStorage(state: unknown, scope: {
  cookieDomains: readonly string[]; storageOrigins: readonly string[];
}): boolean {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) return false;
  const cookies = new Set<string>();
  for (const cookie of parsed.data.cookies) {
    const key = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
    if (!scope.cookieDomains.includes(cookie.domain) || cookies.has(key)) return false;
    cookies.add(key);
  }
  const origins = new Set<string>();
  for (const entry of parsed.data.origins) {
    try {
      const url = new URL(entry.origin);
      if (url.protocol !== "https:" || url.origin !== entry.origin || !scope.storageOrigins.includes(entry.origin)) return false;
    } catch { return false; }
    if (origins.has(entry.origin)) return false;
    origins.add(entry.origin);
    const keys = entry.localStorage.map(item => item.name);
    if (new Set(keys).size !== keys.length) return false;
  }
  return true;
}
