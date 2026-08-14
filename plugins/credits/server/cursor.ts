export function encodeCursor(id: number): string {
  return Buffer.from(String(id), "utf-8").toString("base64");
}

export function decodeCursor(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return null;
  }
  const n = Number(decoded);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
