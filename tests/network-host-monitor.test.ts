import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const script = path.resolve(__dirname, "../scripts/vox-network-monitor.py");
const program = `
import importlib.util, json, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("vox_host_monitor_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.platform.system = lambda: "Linux"
with tempfile.TemporaryDirectory(prefix="vox-host-monitor-test-") as root:
    real_path = pathlib.Path
    nic = real_path(root) / "sys/class/net/wlan0/wireless"
    nic.mkdir(parents=True)
    module.Path = lambda value: real_path(root) / value.lstrip("/")
    calls = []
    def command(*args):
        calls.append(args)
        if args == ("ip", "route", "get", "1.1.1.1"):
            return sys.argv[2]
        if args == ("ip", "-o", "addr", "show", "dev", "wlan0"):
            return sys.argv[3]
        if args == ("iw", "dev", "wlan0", "link"):
            return "Connected to 00:11:22:33:44:55 (on wlan0)"
        raise ValueError("Unexpected command")
    module.command = command
    try:
        print(json.dumps({"observation": module.observe(), "calls": calls}))
    except ValueError:
        print(json.dumps({"unavailable": True, "calls": calls}))
`;
function observe(route: string, addresses: string) {
  return JSON.parse(execFileSync("python3", ["-B", "-c", program, script, route, addresses], { encoding: "utf8" }));
}

describe("private host sampler", () => {
  it("emits a coarse link and hash, not raw source, gateway, interface or BSSID", () => {
    const { observation } = observe("1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.5", "2: wlan0 inet 192.168.1.5/24");
    expect(observation).toEqual(["wifi", expect.stringMatching(/^[a-f0-9]{64}$/), false]);
    expect(JSON.stringify(observation)).not.toMatch(/192\.168|wlan0|00:11/);
  });
  it("refreshes public IPv4 evidence and ignores IPv6-only evidence", () => {
    expect(observe("1.1.1.1 dev wlan0 src 8.8.8.8", "2: wlan0 inet 8.8.8.8/24").observation[2]).toBe(true);
    expect(observe("1.1.1.1 dev wlan0", "2: wlan0 inet6 2601:646::1/64").observation[2]).toBeNull();
  });
  it("fails closed before using an invalid interface in any command or path", () => {
    const result = observe("1.1.1.1 dev ../../private src 192.168.1.5", "");
    expect(result.unavailable).toBe(true);
    expect(result.calls).toHaveLength(1);
  });
});
