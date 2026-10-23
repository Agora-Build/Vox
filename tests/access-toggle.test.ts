// The access toggle and the leaderboard's last-mile / datacenter columns
// (client/src/lib/access-view.ts, used by components/metrics-tag-controls.tsx) read the same URL tag
// filters. A filter the toggle has no button for (access:unknown) must press
// no button — not "All" — and must hide the split columns, which only make
// sense when results of every access class are on the board.
import { describe, it, expect } from "vitest";
import { accessView, withAccessView, showAccessSplit } from "../client/src/lib/access-view";

describe("access toggle state", () => {
  it("no access filter → All", () => {
    expect(accessView([{ key: "run", value: "x" }])).toBe("all");
  });
  it("access:lastmile / access:datacenter → that button", () => {
    expect(accessView([{ key: "access", value: "lastmile" }])).toBe("lastmile");
    expect(accessView([{ key: "access", value: "datacenter" }])).toBe("datacenter");
  });
  it("access:unknown → 'other': no button pressed, not All", () => {
    expect(accessView([{ key: "access", value: "unknown" }])).toBe("other");
  });
  it("choosing All removes any access filter, including unknown; other filters stay", () => {
    expect(withAccessView([{ key: "access", value: "unknown" }, { key: "run", value: "x" }], "all")).toEqual([{ key: "run", value: "x" }]);
    expect(withAccessView([{ key: "access", value: "unknown" }], "lastmile")).toEqual([{ key: "access", value: "lastmile" }]);
  });
});

describe("leaderboard split columns", () => {
  it("shown only when there is no access filter at all", () => {
    expect(showAccessSplit([])).toBe(true);
    expect(showAccessSplit([{ key: "run", value: "x" }])).toBe(true);
    expect(showAccessSplit([{ key: "access", value: "lastmile" }])).toBe(false);
    expect(showAccessSplit([{ key: "access", value: "unknown" }])).toBe(false);
  });
});
