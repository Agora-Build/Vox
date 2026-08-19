import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { injectStorageSession } from "../vox_eval_agentd/session-inject";

describe("injectStorageSession", () => {
  it("forces storage mode, injects storage_file, strips credentials", () => {
    const src = `- type: platform.setup
  platform_id: vapi
  mode: account
  params:
    mode: account
    email: \${secrets.E}
    password: \${secrets.P}
    assistant_id: abc
- type: audio.start_recording`;
    const result = injectStorageSession(src, "/tmp/s.json");
    expect(result.injected).toBe(true);
    const out = yaml.load(result.yaml) as any[];
    const setup = out[0];
    expect(setup.mode).toBe("storage");
    expect(setup.params.mode).toBe("storage");
    expect(setup.params.storage_file).toBe("/tmp/s.json");
    expect(setup.params.email).toBeUndefined();
    expect(setup.params.password).toBeUndefined();
    expect(setup.params.assistant_id).toBe("abc"); // non-credential params survive
    expect(out[1]).toEqual({ type: "audio.start_recording" }); // other steps untouched
  });
  it("handles a setup step with no params block", () => {
    const src = `- type: platform.setup\n  platform_id: livekit`;
    const result = injectStorageSession(src, "/f.json");
    expect(result.injected).toBe(true);
    const out = yaml.load(result.yaml) as any[];
    expect(out[0].mode).toBe("storage");
    expect(out[0].params.storage_file).toBe("/f.json");
  });
  it("transforms EVERY platform.setup step and signals injected=false when none", () => {
    const two = `- type: platform.setup\n  platform_id: a\n- type: platform.setup\n  platform_id: b`;
    const twoRes = injectStorageSession(two, "/f.json");
    expect(twoRes.injected).toBe(true);
    const out = yaml.load(twoRes.yaml) as any[];
    expect(out.every(s => s.mode === "storage")).toBe(true);

    const none = `- type: audio.play\n  corpus_id: x`;
    const noneRes = injectStorageSession(none, "/f.json");
    expect(noneRes.injected).toBe(false);
    expect(noneRes.yaml).toBe(none); // unchanged input returned verbatim
    expect(yaml.load(noneRes.yaml)).toEqual(yaml.load(none));
  });
  it("handles the full-scenario { steps: [...] } document shape and dumps it back", () => {
    const doc = `name: my_scenario
steps:
  - type: platform.setup
    platform_id: vapi
    params:
      email: \${secrets.E}
      password: \${secrets.P}
  - type: audio.start_recording`;
    const result = injectStorageSession(doc, "/tmp/s.json");
    expect(result.injected).toBe(true);
    const out = yaml.load(result.yaml) as { name: string; steps: any[] };
    // Same document shape preserved (not flattened to a bare list).
    expect(out.name).toBe("my_scenario");
    expect(out.steps[0].mode).toBe("storage");
    expect(out.steps[0].params.storage_file).toBe("/tmp/s.json");
    expect(out.steps[0].params.email).toBeUndefined();
    expect(out.steps[0].params.password).toBeUndefined();
    expect(out.steps[1]).toEqual({ type: "audio.start_recording" });
  });
  it("a { steps: [...] } document with no platform.setup returns injected=false", () => {
    const doc = `name: s\nsteps:\n  - type: audio.play\n    corpus_id: x`;
    const result = injectStorageSession(doc, "/f.json");
    expect(result.injected).toBe(false);
    expect(result.yaml).toBe(doc);
  });
});
