/**
 * The one place the console words the `access` classes (design "Last mile vs
 * datacenter"): the toggle, the Leaderboard header, the Agents page badge and
 * the job page's tag tooltip all read from here.
 */

export const LAST_MILE_HINT = "Measured over a real home, office or mobile connection";
export const DATACENTER_HINT = "Measured from a server in a datacenter or cloud";
export const UNKNOWN_ACCESS_TEXT = "Connection type unknown";

/** Lower-case label (used after "Verified · ") and its one-line explanation, per known class. */
export const ACCESS_TEXT: Record<"lastmile" | "datacenter", { label: string; hint: string }> = {
  lastmile: { label: "last mile", hint: `Last mile: ${LAST_MILE_HINT.toLowerCase()}` },
  datacenter: { label: "datacenter", hint: `Datacenter: ${DATACENTER_HINT.toLowerCase()}` },
};

/** The explanation for an access value, e.g. "Last mile: measured over …"; unknown/other → "Connection type unknown". */
export function accessHint(value: string | null | undefined): string {
  return value === "lastmile" || value === "datacenter" ? ACCESS_TEXT[value].hint : UNKNOWN_ACCESS_TEXT;
}
