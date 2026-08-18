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
    const out = yaml.load(injectStorageSession(src, "/tmp/s.json")) as any[];
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
    const out = yaml.load(injectStorageSession(src, "/f.json")) as any[];
    expect(out[0].mode).toBe("storage");
    expect(out[0].params.storage_file).toBe("/f.json");
  });
  it("transforms EVERY platform.setup step and returns input unchanged when none", () => {
    const two = `- type: platform.setup\n  platform_id: a\n- type: platform.setup\n  platform_id: b`;
    const out = yaml.load(injectStorageSession(two, "/f.json")) as any[];
    expect(out.every(s => s.mode === "storage")).toBe(true);
    const none = `- type: audio.play\n  corpus_id: x`;
    expect(yaml.load(injectStorageSession(none, "/f.json"))).toEqual(yaml.load(none));
  });
});
