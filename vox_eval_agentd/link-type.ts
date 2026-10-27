/**
 * Link-type detection — the agent's side of "Detection" → link in
 * designs/2026-10-22-network-tags-design.md. Reported on every
 * register/heartbeat, refreshed each beat, exactly like `capabilities`.
 *
 * Injectable (env/platform/sysRoot/exec) so detection never touches the
 * real network stack in tests. The real call from vox-agentd.ts passes
 * `process.env`, `process.platform`, `''` (real root) and a sync `exec`
 * wrapping `execFileSync` — one `ip route get` (plus, on macOS, one
 * `networksetup`), cheap enough to run on every beat.
 *
 * No shell, ever: `exec` takes a program and an argument array
 * (`execFileSync(file, args)`), and an interface name read from the OS is
 * checked against `IFACE_NAME_RE` before it is used anywhere (an argument
 * or a /sys path) — an invalid one means "couldn't tell", i.e. undefined.
 *
 * Precedence (same as every other reported field): `VOX_LINK_TYPE` in the
 * environment — set by vox-upgrade.sh from the HOST's own detection, since
 * a container only sees its own veth, not the host's NIC — wins outright
 * and skips detection. An invalid value there is ignored, not an error:
 * falls through to normal detection, same as Core does with the field it
 * receives (`parseLinkTypeUpdate` in server/routes.ts).
 *
 * Any detection failure — no default route, an unsupported platform, a
 * failed exec, a missing /sys entry, a virtual default-route interface (no
 * sysfs `device`: a container's veth, a bridge, a tunnel — the real link is
 * behind it) — returns `undefined`, never throws.
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
  /** Runs `file` with `args` — NO shell (`execFileSync`) — and returns its stdout, or throws on failure. */
  exec: (file: string, args: readonly string[]) => string;
}

/** Linux allows up to 15 bytes, any byte but `/`, NUL and whitespace; real
 *  names (eth0, wlp3s0, enp0s31f6, wwan0, veth1@if5, en0, utun3, eth0.100,
 *  eth0:1) all fit this. Anything else is treated as "couldn't tell". */
const IFACE_NAME_RE = /^[A-Za-z0-9._@:-]{1,32}$/;

export function isValidInterfaceName(name: string | undefined): name is string {
  return name !== undefined && IFACE_NAME_RE.test(name) && name !== "." && name !== "..";
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
  const out = exec("ip", ["route", "get", "1.1.1.1"]);
  const iface = out.match(/\bdev\s+(\S+)/)?.[1];
  return isValidInterfaceName(iface) ? iface : undefined;
}

function detectLinux(sysRoot: string, exec: DetectLinkTypeDeps["exec"]): LinkType | undefined {
  const iface = defaultRouteInterface(exec);
  if (!iface) return undefined;

  const ifaceDir = path.join(sysRoot, "/sys/class/net", iface);
  if (fs.existsSync(path.join(ifaceDir, "wireless"))) return "wifi";
  if (/^wwan/.test(iface)) return "cellular";

  // A virtual interface — a container's veth, a bridge, a VPN tunnel — has
  // no backing hardware, so sysfs gives it no `device` entry (its
  // /sys/class/net/<if> points into /sys/devices/virtual/net/; a real NIC's
  // points into its bus, e.g. pci0000:00/.../net/eno2, and has `device`).
  // Inside a container the default route is always the veth, so without
  // VOX_LINK_TYPE there is nothing to tell the host's real link from:
  // report nothing rather than fabricate "ethernet".
  if (!fs.existsSync(path.join(ifaceDir, "device"))) return undefined;

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
  const routeOut = exec("route", ["-n", "get", "default"]);
  const iface = routeOut.match(/^\s*interface:\s*(\S+)/m)?.[1];
  if (!isValidInterfaceName(iface)) return undefined;

  const listing = exec("networksetup", ["-listallhardwareports"]);
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
