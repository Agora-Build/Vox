import { describe, it, expect } from 'vitest';

// ─── Pure function implementations for testing ──────────────────────────────
// These mirror logic from the clash runner modules but are defined here
// to avoid importing modules with heavy dependencies (Playwright, fs, child_process).

function resolveSecrets(value: string, secrets: Record<string, string>): string {
  return value.replace(/\$\{secrets\.(\w+)\}/g, (_, key) => secrets[key] ?? "");
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function calculateElo(
  ratingA: number,
  ratingB: number,
  outcome: "a_wins" | "b_wins" | "draw"
): { newRatingA: number; newRatingB: number } {
  const K = 32;
  const ea = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const eb = 1 - ea;
  const sa = outcome === "a_wins" ? 1 : outcome === "b_wins" ? 0 : 0.5;
  const sb = 1 - sa;
  return {
    newRatingA: Math.round(ratingA + K * (sa - ea)),
    newRatingB: Math.round(ratingB + K * (sb - eb)),
  };
}

const VALID_ACTIONS = ["click", "fill", "wait", "select", "press"] as const;

function isValidAction(action: string): action is typeof VALID_ACTIONS[number] {
  return (VALID_ACTIONS as readonly string[]).includes(action);
}

// ─── Warm pool API helper (mirrors clash-runner.ts apiCall logic) ────────────

function buildApiHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

interface AssignmentResponse {
  assigned: boolean;
  match?: { id: number; topic: string; region: string };
  agentA?: { id: number; name: string; agentUrl: string };
  agentB?: { id: number; name: string; agentUrl: string };
}

function parseAssignmentResponse(data: AssignmentResponse): {
  isAssigned: boolean;
  matchId: number | null;
} {
  if (!data.assigned) {
    return { isAssigned: false, matchId: null };
  }
  return {
    isAssigned: true,
    matchId: data.match?.id ?? null,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Clash Runner", () => {

  // ── Browser Agent: Placeholder Resolution ───────────────────────────────

  describe("resolveSecrets", () => {
    it("replaces a single placeholder with the matching secret", () => {
      const result = resolveSecrets("Bearer ${secrets.API_KEY}", { API_KEY: "abc123" });
      expect(result).toBe("Bearer abc123");
    });

    it("replaces multiple placeholders in the same string", () => {
      const result = resolveSecrets(
        "${secrets.USER}:${secrets.PASS}",
        { USER: "admin", PASS: "s3cret" }
      );
      expect(result).toBe("admin:s3cret");
    });

    it("replaces missing secret keys with empty string", () => {
      const result = resolveSecrets("token=${secrets.MISSING}", {});
      expect(result).toBe("token=");
    });

    it("leaves strings without placeholders unchanged", () => {
      const result = resolveSecrets("no placeholders here", { KEY: "val" });
      expect(result).toBe("no placeholders here");
    });

    it("handles empty string input", () => {
      expect(resolveSecrets("", { KEY: "val" })).toBe("");
    });

    it("handles empty secrets object", () => {
      const result = resolveSecrets("${secrets.A} and ${secrets.B}", {});
      expect(result).toBe(" and ");
    });

    it("only matches the ${secrets.KEY} pattern, not other patterns", () => {
      const result = resolveSecrets("${env.HOME} ${secrets.TOKEN}", { TOKEN: "xyz" });
      expect(result).toBe("${env.HOME} xyz");
    });

    it("handles keys with underscores and digits", () => {
      const result = resolveSecrets("${secrets.MY_KEY_2}", { MY_KEY_2: "value2" });
      expect(result).toBe("value2");
    });
  });

  // ── Browser Agent: Setup Step Schema Validation ─────────────────────────

  describe("setup step schema validation", () => {
    it("accepts valid actions", () => {
      for (const action of VALID_ACTIONS) {
        expect(isValidAction(action)).toBe(true);
      }
    });

    it("rejects invalid actions", () => {
      expect(isValidAction("hover")).toBe(false);
      expect(isValidAction("type")).toBe(false);
      expect(isValidAction("navigate")).toBe(false);
      expect(isValidAction("")).toBe(false);
    });
  });

  // ── Observer: computeMedian ─────────────────────────────────────────────

  describe("computeMedian", () => {
    it("returns null for an empty array", () => {
      expect(computeMedian([])).toBeNull();
    });

    it("returns the single element for a one-element array", () => {
      expect(computeMedian([42])).toBe(42);
    });

    it("returns the middle element for an odd-length array", () => {
      expect(computeMedian([3, 1, 2])).toBe(2);
    });

    it("returns the average of two middle elements for an even-length array", () => {
      expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
    });

    it("handles already-sorted input", () => {
      expect(computeMedian([10, 20, 30, 40, 50])).toBe(30);
    });

    it("handles unsorted input correctly", () => {
      expect(computeMedian([50, 10, 40, 20, 30])).toBe(30);
    });

    it("handles duplicate values", () => {
      expect(computeMedian([5, 5, 5])).toBe(5);
    });

    it("handles negative values", () => {
      expect(computeMedian([-10, -5, 0, 5, 10])).toBe(0);
    });

    it("handles two elements (even)", () => {
      expect(computeMedian([100, 200])).toBe(150);
    });
  });

  // ── Observer: computeStdDev ─────────────────────────────────────────────

  describe("computeStdDev", () => {
    it("returns 0 for a single element", () => {
      expect(computeStdDev([42])).toBe(0);
    });

    it("returns 0 for an empty array (fewer than 2 elements)", () => {
      expect(computeStdDev([])).toBe(0);
    });

    it("computes standard deviation for two identical elements", () => {
      expect(computeStdDev([5, 5])).toBe(0);
    });

    it("computes standard deviation for two elements", () => {
      // [10, 20]: mean = 15, variance = ((10-15)^2 + (20-15)^2) / 2 = 25, sd = 5
      expect(computeStdDev([10, 20])).toBe(5);
    });

    it("computes population standard deviation correctly", () => {
      // [2, 4, 4, 4, 5, 5, 7, 9]: mean = 5, variance = 4, sd = 2
      expect(computeStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    });

    it("handles values with fractional standard deviation", () => {
      // [1, 2, 3]: mean = 2, variance = (1+0+1)/3 = 2/3, sd ≈ 0.8165
      const sd = computeStdDev([1, 2, 3]);
      expect(sd).toBeCloseTo(0.8165, 3);
    });

    it("handles negative values", () => {
      // [-2, 0, 2]: mean = 0, variance = (4+0+4)/3 = 8/3, sd ≈ 1.6330
      const sd = computeStdDev([-2, 0, 2]);
      expect(sd).toBeCloseTo(1.6330, 3);
    });
  });

  // ── Elo Calculation ─────────────────────────────────────────────────────

  describe("calculateElo", () => {
    it("winner rating goes up, loser rating goes down", () => {
      const { newRatingA, newRatingB } = calculateElo(1500, 1500, "a_wins");
      expect(newRatingA).toBeGreaterThan(1500);
      expect(newRatingB).toBeLessThan(1500);
    });

    it("both start at 1500 — symmetric result for a_wins", () => {
      const { newRatingA, newRatingB } = calculateElo(1500, 1500, "a_wins");
      // Expected A = ea = 0.5, sa = 1, delta = 32 * (1 - 0.5) = 16
      expect(newRatingA).toBe(1516);
      expect(newRatingB).toBe(1484);
    });

    it("both start at 1500 — symmetric result for b_wins", () => {
      const { newRatingA, newRatingB } = calculateElo(1500, 1500, "b_wins");
      expect(newRatingA).toBe(1484);
      expect(newRatingB).toBe(1516);
    });

    it("draw — ratings move toward each other when unequal", () => {
      const { newRatingA, newRatingB } = calculateElo(1600, 1400, "draw");
      // Higher-rated player loses points, lower-rated gains
      expect(newRatingA).toBeLessThan(1600);
      expect(newRatingB).toBeGreaterThan(1400);
    });

    it("draw between equal ratings — no change", () => {
      const { newRatingA, newRatingB } = calculateElo(1500, 1500, "draw");
      expect(newRatingA).toBe(1500);
      expect(newRatingB).toBe(1500);
    });

    it("upset — lower-rated winner gets larger rating change", () => {
      // B (1300) beats A (1700)
      const { newRatingA, newRatingB } = calculateElo(1700, 1300, "b_wins");
      const deltaA = 1700 - newRatingA;
      const deltaB = newRatingB - 1300;
      // Both deltas are the same (zero-sum), but should be large due to upset
      expect(deltaA).toBe(deltaB);
      // The delta should be larger than a 1500 vs 1500 game (which is 16)
      expect(deltaA).toBeGreaterThan(16);
    });

    it("K-factor of 32 is applied correctly — exact values for equal ratings", () => {
      const { newRatingA, newRatingB } = calculateElo(1500, 1500, "a_wins");
      // ea = 0.5, sa = 1, delta = 32 * (1 - 0.5) = 16
      expect(newRatingA - 1500).toBe(16);
      expect(1500 - newRatingB).toBe(16);
    });

    it("K-factor of 32 — exact values for mismatched ratings", () => {
      // A=1600, B=1400: ea = 1/(1+10^(-200/400)) = 1/(1+10^-0.5) ≈ 0.7597
      const { newRatingA, newRatingB } = calculateElo(1600, 1400, "a_wins");
      const ea = 1 / (1 + Math.pow(10, -200 / 400));
      const expectedDelta = Math.round(32 * (1 - ea));
      expect(newRatingA).toBe(1600 + expectedDelta);
      expect(newRatingB).toBe(1400 - expectedDelta);
    });

    it("total rating is conserved (zero-sum)", () => {
      const { newRatingA, newRatingB } = calculateElo(1800, 1200, "a_wins");
      // Due to rounding, allow ±1
      expect(Math.abs(newRatingA + newRatingB - 3000)).toBeLessThanOrEqual(1);
    });

    it("total rating is conserved for draws", () => {
      const { newRatingA, newRatingB } = calculateElo(1650, 1350, "draw");
      expect(Math.abs(newRatingA + newRatingB - 3000)).toBeLessThanOrEqual(1);
    });
  });

  // ── Warm Pool: API call helper ───────────────────────────────────────────

  describe("buildApiHeaders", () => {
    it("includes Authorization Bearer token", () => {
      const headers = buildApiHeaders("my-runner-token-abc");
      expect(headers["Authorization"]).toBe("Bearer my-runner-token-abc");
    });

    it("includes Content-Type application/json", () => {
      const headers = buildApiHeaders("token");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("returns exactly two header keys", () => {
      const headers = buildApiHeaders("token");
      expect(Object.keys(headers).length).toBe(2);
    });

    it("handles tokens with special characters", () => {
      const token = "runner-token_v2.abc123+XYZ==";
      const headers = buildApiHeaders(token);
      expect(headers["Authorization"]).toBe(`Bearer ${token}`);
    });
  });

  // ── Warm Pool: Assignment response parsing ───────────────────────────────

  describe("parseAssignmentResponse", () => {
    it("returns isAssigned=false when assigned is false", () => {
      const result = parseAssignmentResponse({ assigned: false });
      expect(result.isAssigned).toBe(false);
      expect(result.matchId).toBeNull();
    });

    it("returns isAssigned=true and matchId when assigned", () => {
      const result = parseAssignmentResponse({
        assigned: true,
        match: { id: 42, topic: "Test topic", region: "na" },
        agentA: { id: 1, name: "Agent A", agentUrl: "https://a.example.com" },
        agentB: { id: 2, name: "Agent B", agentUrl: "https://b.example.com" },
      });
      expect(result.isAssigned).toBe(true);
      expect(result.matchId).toBe(42);
    });

    it("returns matchId=null when assigned=true but match is missing", () => {
      const result = parseAssignmentResponse({ assigned: true });
      expect(result.isAssigned).toBe(true);
      expect(result.matchId).toBeNull();
    });

    it("extracts correct matchId from nested match object", () => {
      const result = parseAssignmentResponse({
        assigned: true,
        match: { id: 99, topic: "Another topic", region: "eu" },
      });
      expect(result.matchId).toBe(99);
    });
  });
});
