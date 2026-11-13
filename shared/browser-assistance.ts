import { z } from "zod";

export const BROWSER_PROTOCOL_VERSION = 1;
export const BROWSER_REQUEST_LIMIT = 16 * 1024;
export const BROWSER_RESPONSE_LIMIT = 4 * 1024 * 1024;
export const BROWSER_ASSISTANCE_SECONDS = 60;

export const browserCommandSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(128),
  command: z.enum([
    "session.status", "viewer.open", "viewer.heartbeat", "viewer.close",
    "viewer.take_control", "viewer.input", "viewer.open_url", "viewer.select_page",
    "viewer.release_control", "assistance.continue", "assistance.cancel", "command.status",
  ]),
  session_id: z.string().max(256).optional(),
  browser_generation: z.string().max(256).nullable().optional(),
  params: z.record(z.unknown()).optional(),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= BROWSER_REQUEST_LIMIT,
  "Browser command is too large");

export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export type BrowserResponse = {
  version: 1; type: "response"; id: string; ok: boolean;
  result?: Record<string, unknown>; error?: string;
  viewer?: BrowserViewerState;
};
export type BrowserViewerState = {
  count: number; controller: "you" | "other" | null; revision: number;
  lease_id: string; page_id: string; document_epoch: number;
};
export type BrowserFrame = {
  version: 1; type: "event"; event: "viewer.frame";
  session_id: string; browser_generation: string; page_id: string;
  document_epoch: number; lease_id: string; data: string;
  metadata: Record<string, number>;
};
export type BrowserPage = { page_id: string; document_epoch: number; origin: string | null };
export type BrowserStatus = {
  session_id: string; browser_generation: string | null; capabilities: string[];
  pages: BrowserPage[]; viewing: boolean; controlling: boolean; next_sequence: number;
  assistance: null | {
    wait_id: string; kind: "authentication" | "element" | "url";
    state: "waiting" | "held" | "checking"; page_id: string; remaining_seconds: number | null;
  };
};
export const browserStatusSchema: z.ZodType<BrowserStatus> = z.object({
  session_id: z.string(), browser_generation: z.string().nullable(), capabilities: z.array(z.string()),
  pages: z.array(z.object({ page_id: z.string(), document_epoch: z.number().int().nonnegative(), origin: z.string().nullable() })),
  viewing: z.boolean(), controlling: z.boolean(), next_sequence: z.number().int().positive(),
  assistance: z.object({ wait_id: z.string(), kind: z.enum(["authentication", "element", "url"]),
    state: z.enum(["waiting", "held", "checking"]), page_id: z.string(), remaining_seconds: z.number().nullable() }).nullable(),
});
export const browserFrameSchema: z.ZodType<BrowserFrame> = z.object({
  version: z.literal(1), type: z.literal("event"), event: z.literal("viewer.frame"),
  session_id: z.string(), browser_generation: z.string(), page_id: z.string(), document_epoch: z.number().int().nonnegative(),
  lease_id: z.string(), data: z.string().max(2_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/), metadata: z.record(z.number().finite()),
});
export const browserOperationSchema = z.object({
  action: z.enum(["status", "command", "frame", "close"]),
  viewerId: z.string().uuid(),
  request: browserCommandSchema.optional(),
}).strict();
export type BrowserOperation = z.infer<typeof browserOperationSchema>;

export function supportsBrowserAssistance(version: string): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  return !!parts && (parts[0] > 0 || parts[1] > 4 || (parts[1] === 4 && parts[2] >= 4));
}
