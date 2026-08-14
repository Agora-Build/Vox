function isPositiveInt(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}
function isNonNegInt(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

export function assertPositiveCredits(credits: number): void {
  if (!isPositiveInt(credits)) throw new Error("invalid amount: must be a positive integer number of credits");
}

export function validateSplit(
  holdAmount: number,
  split: { earnerShare: number; platformFeeCredits: number },
): void {
  if (!isNonNegInt(split.earnerShare) || !isNonNegInt(split.platformFeeCredits)) {
    throw new Error("invalid split: parts must be non-negative integers");
  }
  if (split.earnerShare + split.platformFeeCredits !== holdAmount) {
    throw new Error(`invalid split: parts must sum to the held amount (${holdAmount})`);
  }
}
