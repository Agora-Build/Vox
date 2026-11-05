/**
 * detectLinkType (vox_eval_agentd/link-type.ts) — the agent's side of
 * "Detection" → link in designs/2026-10-22-network-tags-design.md.
 *
 * Injectable (env/platform/sysRoot/exec), so these tests never touch the
 * real network stack or real /sys — a fake /sys tree in a temp dir plus a
 * canned `exec` stand in for `ip route get` / `route -n get default` /
 * `networksetup -listallhardwareports`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { detectLinkType, type DetectLinkTypeDeps } from "../vox_eval_agentd/link-type";

let sysRoot = "";

beforeEach(() => {
  sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vox-link-type-test-"));
});
afterEach(() => {
  fs.rmSync(sysRoot, { recursive: true, force: true });
});

/** Create `${sysRoot}/sys/class/net/<iface>/` so detection has an interface to inspect. */
function makeIface(iface: string) {
  fs.mkdirSync(path.join(sysRoot, "sys", "class", "net", iface), { recursive: true });
}

function makeWireless(iface: string) {
  fs.writeFileSync(path.join(sysRoot, "sys", "class", "net", iface, "wireless"), "");
}

function makeDriverSymlink(iface: string, driverBasename: string) {
  const deviceDir = path.join(sysRoot, "sys", "class", "net", iface, "device");
  fs.mkdirSync(deviceDir, { recursive: true });
  // A real sysfs driver symlink is relative and the target need not exist on
  // disk for our purposes — detection only reads the link text and takes its
  // basename, exactly like `readlink` would on a real host.
  fs.symlinkSync(`../../../bus/usb/drivers/${driverBasename}`, path.join(deviceDir, "driver"));
}

function deps(overrides: Partial<DetectLinkTypeDeps> & { exec: DetectLinkTypeDeps["exec"] }): DetectLinkTypeDeps {
  return { env: {}, platform: "linux", sysRoot, ...overrides };
}

function execFake(responses: Record<string, string>): DetectLinkTypeDeps["exec"] {
  // exec is (file, args) with no shell; key the canned answers by the joined
  // command line for readability.
  return (file: string, args: readonly string[]) => {
    const cmd = [file, ...args].join(" ");
    if (!(cmd in responses)) throw new Error(`unexpected exec: ${cmd}`);
    return responses[cmd];
  };
}

function throwingExec(message = "boom"): DetectLinkTypeDeps["exec"] {
  return () => {
    throw new Error(message);
  };
}

describe("detectLinkType — linux", () => {
  it("wifi: default-route interface has /sys/class/net/<if>/wireless", () => {
    makeIface("wlan0");
    makeWireless("wlan0");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.5 uid 1000 \n    cache" }) })
    );
    expect(result).toBe("wifi");
  });

  it("cellular: default-route interface name matches wwan*", () => {
    makeIface("wwan0");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 10.0.0.1 dev wwan0 src 10.0.0.5" }) })
    );
    expect(result).toBe("cellular");
  });

  it("cellular: driver symlink resolves to qmi_wwan", () => {
    makeIface("eth1");
    makeDriverSymlink("eth1", "qmi_wwan");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 10.0.0.1 dev eth1 src 10.0.0.5" }) })
    );
    expect(result).toBe("cellular");
  });

  it("cellular: driver symlink resolves to cdc_mbim", () => {
    makeIface("eth2");
    makeDriverSymlink("eth2", "cdc_mbim");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 10.0.0.1 dev eth2 src 10.0.0.5" }) })
    );
    expect(result).toBe("cellular");
  });

  it("ethernet: no wireless file, name doesn't match wwan*, driver is an ordinary NIC driver", () => {
    makeIface("eth0");
    makeDriverSymlink("eth0", "e1000e");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5" }) })
    );
    expect(result).toBe("ethernet");
  });

  it("ethernet: a hardware device with no driver symlink still falls through to ethernet", () => {
    makeIface("eth0");
    fs.mkdirSync(path.join(sysRoot, "sys", "class", "net", "eth0", "device"));
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5" }) })
    );
    expect(result).toBe("ethernet");
  });

  it("virtual interface (a container's veth: no sysfs device entry) → undefined, not a fabricated ethernet", () => {
    // What `docker run` shows: /sys/class/net/eth0 → ../../devices/virtual/net/eth0, no `device`.
    makeIface("eth0");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 172.17.0.1 dev eth0 src 172.17.0.2 uid 0" }) })
    );
    expect(result).toBeUndefined();
  });

  it("virtual interface on a host (bridge / tunnel) → undefined too", () => {
    makeIface("br0");
    const result = detectLinkType(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev br0 src 192.168.1.5" }) })
    );
    expect(result).toBeUndefined();
  });

  it("in a container, VOX_LINK_TYPE (from vox-upgrade.sh's host detection) still wins over the veth", () => {
    makeIface("eth0");
    const result = detectLinkType(
      deps({ env: { VOX_LINK_TYPE: "wifi" }, exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 172.17.0.1 dev eth0" }) })
    );
    expect(result).toBe("wifi");
  });

  it("exec throws (no default route / ip missing) → undefined, never throws", () => {
    const result = detectLinkType(deps({ exec: throwingExec("ip: command not found") }));
    expect(result).toBeUndefined();
  });

  it("no 'dev <if>' in ip's output → undefined", () => {
    const result = detectLinkType(deps({ exec: execFake({ "ip route get 1.1.1.1": "RTNETLINK answers: Network is unreachable" }) }));
    expect(result).toBeUndefined();
  });
});

describe("detectLinkType — env override", () => {
  it("VOX_LINK_TYPE wins over detection — exec is never even called", () => {
    const result = detectLinkType(
      deps({ env: { VOX_LINK_TYPE: "satellite" }, exec: throwingExec("must not be called") })
    );
    expect(result).toBe("satellite");
  });

  it("an invalid VOX_LINK_TYPE is ignored — falls through to real detection", () => {
    makeIface("eth0");
    makeDriverSymlink("eth0", "e1000e");
    const result = detectLinkType(
      deps({
        env: { VOX_LINK_TYPE: "5g" },
        exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5" }),
      })
    );
    expect(result).toBe("ethernet");
  });
});

describe("detectLinkType — darwin", () => {
  const HW_PORTS = `Hardware Port: Wi-Fi
Device: en0
Ethernet Address: ac:de:48:00:11:22

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: N/A

Hardware Port: USB 10/100/1000 LAN
Device: en5
Ethernet Address: 00:11:22:33:44:55
`;

  it("wifi: default-route interface's hardware port is Wi-Fi", () => {
    const result = detectLinkType(
      deps({
        platform: "darwin",
        exec: execFake({
          "route -n get default": "   route to: default\n  interface: en0\n      flags: <UP,GATEWAY>\n",
          "networksetup -listallhardwareports": HW_PORTS,
        }),
      })
    );
    expect(result).toBe("wifi");
  });

  it("ethernet: default-route interface's hardware port is not Wi-Fi", () => {
    const result = detectLinkType(
      deps({
        platform: "darwin",
        exec: execFake({
          "route -n get default": "   route to: default\n  interface: en5\n      flags: <UP,GATEWAY>\n",
          "networksetup -listallhardwareports": HW_PORTS,
        }),
      })
    );
    expect(result).toBe("ethernet");
  });

  it("no interface in route output → undefined", () => {
    const result = detectLinkType(
      deps({
        platform: "darwin",
        exec: execFake({ "route -n get default": "route: no default route", "networksetup -listallhardwareports": HW_PORTS }),
      })
    );
    expect(result).toBeUndefined();
  });

  it("networksetup failing → undefined (any error → undefined)", () => {
    const result = detectLinkType(
      deps({
        platform: "darwin",
        exec: (file: string, args: readonly string[]) => {
          if ([file, ...args].join(" ") === "route -n get default") return "  interface: en0\n";
          throw new Error("networksetup: command not found");
        },
      })
    );
    expect(result).toBeUndefined();
  });
});

describe("detectLinkType — unsupported platform", () => {
  it("returns undefined without calling exec", () => {
    const result = detectLinkType(deps({ platform: "win32", exec: throwingExec("must not be called") }));
    expect(result).toBeUndefined();
  });
});

describe("detectLinkType — hostile interface names (no shell, validated)", () => {
  it("linux: metacharacters in the default-route interface → undefined, never used", () => {
    // A matching sysfs entry exists (wireless), so only the name check stops a "wifi" answer.
    fs.mkdirSync(path.join(sysRoot, "sys", "class", "net", "wlan0;rm$IFS-rf$IFS~", "wireless"), { recursive: true });
    const calls: string[] = [];
    const result = detectLinkType(
      deps({
        exec: (file, args) => {
          calls.push([file, ...args].join(" "));
          return "1.1.1.1 via 192.168.1.1 dev wlan0;rm$IFS-rf$IFS~ src 192.168.1.5";
        },
      })
    );
    expect(result).toBeUndefined();
    expect(calls).toEqual(["ip route get 1.1.1.1"]);
  });

  it("linux: `../..`-style names are rejected before any /sys lookup", () => {
    // /sys/class/net/.. is /sys/class: a wireless dir there would make an unvalidated name read as wifi.
    fs.mkdirSync(path.join(sysRoot, "sys", "class", "wireless"), { recursive: true });
    const result = detectLinkType(deps({ exec: () => "1.1.1.1 via 10.0.0.1 dev .. src 10.0.0.5" }));
    expect(result).toBeUndefined();
  });

  it("darwin: a hostile interface name never reaches networksetup", () => {
    const calls: string[] = [];
    const result = detectLinkType(
      deps({
        platform: "darwin",
        exec: (file, args) => {
          calls.push(file);
          if (file === "route") return "  interface: en0`reboot`\n";
          return "Hardware Port: Wi-Fi\nDevice: en0`reboot`\n";
        },
      })
    );
    expect(result).toBeUndefined();
    expect(calls).toEqual(["route"]);
  });

  it("route lookups are argument arrays", () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    detectLinkType(deps({ exec: (file, args) => { calls.push({ file, args }); return ""; } }));
    expect(calls).toEqual([{ file: "ip", args: ["route", "get", "1.1.1.1"] }]);
  });
});
