export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
