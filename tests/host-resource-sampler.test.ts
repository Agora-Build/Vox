import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const script = path.resolve(__dirname, "../scripts/vox-network-monitor.py");
const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("vox_resource_sampler_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.platform.system = lambda: sys.argv[2]
files = {"/proc/stat": "cpu 10 0 10 60 20 0 0 0 100 100", "/proc/meminfo": sys.argv[3]}
class FakePath:
    def __init__(self, name): self.name = name
    def read_text(self): return files[self.name]
module.Path = FakePath
sampler = module.ResourceSampler()
try:
    first = sampler.sample()
    files["/proc/stat"] = "cpu 40 0 20 120 20 0 0 0 200 200"
    print(json.dumps({"first": first, "sample": sampler.sample()}))
except ValueError:
    print(json.dumps({"unavailable": True}))
`;
const sample = (platform = "Linux", memory = "MemTotal: 1000 kB\nMemAvailable: 300 kB\nMemFree: 1 kB\n") =>
  JSON.parse(execFileSync("python3", ["-B", "-c", program, script, platform, memory], { encoding: "utf8" }));

describe("unprivileged Python host resource sampler", () => {
  it("warms the CPU counters and reports machine utilization plus reclaimable-aware memory", () => {
    expect(sample()).toEqual({ first: null, sample: { cpuPercent: 40, memoryPercent: 70 } });
  });
  it("does not silently substitute free memory for missing MemAvailable", () => {
    expect(sample("Linux", "MemTotal: 1000 kB\nMemFree: 300 kB\n")).toEqual({ unavailable: true });
  });
  it("reports unsupported hosts explicitly instead of inventing healthy values", () => {
    expect(sample("Darwin")).toEqual({ unavailable: true });
  });
});
