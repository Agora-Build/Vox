export function regionSiteSequence(region: string, baseId: string): number | null {
  const prefix = `${baseId}-`;
  if (!region.startsWith(prefix)) return null;

  const rawSequence = region.slice(prefix.length);
  if (!/^\d+$/.test(rawSequence)) return null;

  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  if (String(sequence).padStart(2, "0") !== rawSequence) return null;
  return sequence;
}
