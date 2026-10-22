/**
 * Link-type detection — the agent's side of "Detection" → link in
 * designs/2026-10-22-network-tags-design.md. Reported on every
 * register/heartbeat, refreshed each beat, exactly like `capabilities`.
 *
 * Injectable (env/platform/sysRoot/exec) so detection never touches the
 * real network stack in tests. The real call from vox-agentd.ts passes
 * `process.env`, `process.platform`, `''` (real root) and a sync `exec`
 * wrapping `execSync` — one `ip route get` (plus, on macOS, one
 * `networksetup`), cheap enough to run on every beat.
 *
 * Precedence (same as every other reported field): `VOX_LINK_TYPE` in the
 * environment — set by vox-upgrade.sh from the HOST's own detection, since
 * a container only sees its own veth, not the host's NIC — wins outright
 * and skips detection. An invalid value there is ignored, not an error:
 * falls through to normal detection, same as Core does with the field it
 * receives (`parseLinkTypeUpdate` in server/routes.ts).
 *
 * Any detection failure — no default route, an unsupported platform, a
 * failed exec, a missing /sys entry — returns `undefined`, never throws.
 * The caller must then OMIT the field on the wire rather than send `null`:
 * `null` means "clear the stored value" to Core, `undefined` here means
 * "couldn't tell this time," which should leave the last known value alone.
 */
import fs from "fs";
import path from "path";
import { LINK_VALUES, type LinkType } from "../shared/tags";

export interface DetectLinkTypeDeps {
  env: Record<string, string | undefined>;
  /** `process.platform`-shaped: only `"linux"` and `"darwin"` are detected; anything else → undefined. */
  platform: string;
  /** Prefixed before `/sys/class/net/...` — `""` for the real root, a temp dir in tests. */
  sysRoot: string;
  /** Runs a shell command and returns its stdout, or throws on failure. */
  exec: (cmd: string) => string;
}

const CELLULAR_DRIVERS = new Set(["qmi_wwan", "cdc_mbim", "cdc_ether"]);

function isLinkValue(value: string | undefined): value is LinkType {
  return value !== undefined && (LINK_VALUES as readonly string[]).includes(value);
}

export function detectLinkType({ env, platform, sysRoot, exec }: DetectLinkTypeDeps): LinkType | undefined {
  const override = env.VOX_LINK_TYPE;
  if (isLinkValue(override)) return override;

  try {
    if (platform === "linux") return detectLinux(sysRoot, exec);
    if (platform === "darwin") return detectDarwin(exec);
    return undefined;
  } catch {
    return undefined;
  }
}

function defaultRouteInterface(exec: DetectLinkTypeDeps["exec"]): string | undefined {
  const out = exec("ip route get 1.1.1.1");
  return out.match(/\bdev\s+(\S+)/)?.[1];
}

function detectLinux(sysRoot: string, exec: DetectLinkTypeDeps["exec"]): LinkType | undefined {
  const iface = defaultRouteInterface(exec);
  if (!iface) return undefined;

  const ifaceDir = path.join(sysRoot, "/sys/class/net", iface);
  if (fs.existsSync(path.join(ifaceDir, "wireless"))) return "wifi";
  if (/^wwan/.test(iface)) return "cellular";

  let driver: string | undefined;
  try {
    driver = path.basename(fs.readlinkSync(path.join(ifaceDir, "device", "driver")));
  } catch {
    driver = undefined;
  }
  if (driver && CELLULAR_DRIVERS.has(driver)) return "cellular";

  return "ethernet";
}

function detectDarwin(exec: DetectLinkTypeDeps["exec"]): LinkType | undefined {
  const routeOut = exec("route -n get default");
  const iface = routeOut.match(/^\s*interface:\s*(\S+)/m)?.[1];
  if (!iface) return undefined;

  const listing = exec("networksetup -listallhardwareports");
  return macHardwarePortFor(iface, listing) === "Wi-Fi" ? "wifi" : "ethernet";
}

/**
 * Add `linkType` to a register/heartbeat body — but only when detected.
 * `undefined` means "couldn't tell this time" and must be OMITTED (Core's
 * `parseLinkTypeUpdate` treats an absent field as "leave the stored value
 * alone"); sending `linkType: undefined` would still omit it once
 * `JSON.stringify`'d, but composing it through this helper keeps that
 * behavior explicit and in one place, and makes it unit-testable without
 * importing the whole daemon (vox-agentd.ts runs its CLI `main()` on
 * import, which this module's callers must never trigger from a test).
 */
export function withLinkType<T extends Record<string, unknown>>(
  body: T,
  linkType: LinkType | undefined
): T & { linkType?: LinkType } {
  return linkType ? { ...body, linkType } : body;
}

/** `networksetup -listallhardwareports` is blank-line-separated records of
 *  `Hardware Port: ...` / `Device: ...` / `Ethernet Address: ...`. Returns
 *  the port name for the record whose Device matches, or undefined if none does. */
function macHardwarePortFor(iface: string, listing: string): string | undefined {
  for (const block of listing.split(/\n\s*\n/)) {
    const device = block.match(/^Device:\s*(\S+)/m)?.[1];
    if (device === iface) {
      return block.match(/^Hardware Port:\s*(.+)$/m)?.[1]?.trim();
    }
  }
  return undefined;
}
