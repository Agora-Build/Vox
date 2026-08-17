export const PLATFORM_FEE_BPS = 2000; // 20% platform fee, owner nets 80%

function isPositiveInt(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}
function isNonNegInt(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

export function computeCharge(pricePerUnit: number, priceUnits: number): number {
  if (!isPositiveInt(pricePerUnit)) throw new Error("invalid price_per_unit: must be a positive integer");
  if (!isPositiveInt(priceUnits)) throw new Error("invalid price_units: must be a positive integer");
  return pricePerUnit * priceUnits;
}

export function computeFee(charge: number): number {
  if (!isPositiveInt(charge)) throw new Error("invalid charge: must be a positive integer");
  return Math.round((charge * PLATFORM_FEE_BPS) / 10000);
}

export function assertValidSplit(charge: number, earnerShare: number, feeCredits: number): void {
  if (!isNonNegInt(earnerShare) || !isNonNegInt(feeCredits)) {
    throw new Error("invalid split: parts must be non-negative integers");
  }
  if (earnerShare + feeCredits !== charge) {
    throw new Error(`invalid split: parts must sum to the charge (${charge})`);
  }
}
