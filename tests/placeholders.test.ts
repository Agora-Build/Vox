import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import yaml from "js-yaml";
import {
  fillJobPlaceholders, unresolvedSecretsError, secretNeedles, scrubSecretsFromArtifacts, jobConfigVars,
} from "../vox_eval_agentd/placeholders";
import { runPhoneJob } from "../vox_eval_agentd/phone-eval";

// The one ${config.*}/${secrets.*} filling step both web and phone jobs run
// (designs/2026-09-29-secret-substitution.md).

const parse = (t: string) => yaml.load(t);
const trusted = { evalSetSecrets: true };
const untrusted = { evalSetSecrets: false };

describe("fillJobPlaceholders", () => {
  // The reported bug: phone jobs never filled `number: ${secrets.X}`.
  it("fills a call.dial number kept as a secret — bare or quoted in the YAML", () => {
    for (const number of ["${secrets.AGENT_PHONE}", "\"${secrets.AGENT_PHONE}\""]) {
      const out = fillJobPlaceholders(
        { scenario: undefined, stepsPrefix: parse(`- type: call.dial\n  number: ${number}\n`), stepsSuffix: undefined },
        {}, { AGENT_PHONE: "+1 234 595 2048" }, untrusted,
      );
      expect(out.parts.stepsPrefix).toEqual([{ type: "call.dial", number: "+1 234 595 2048" }]);
      expect(out.unsupplied).toEqual([]);
    }
  });

  it("fills Setup and Teardown always; the eval set only when trusted", () => {
    const parts = {
      scenario: { steps: [{ type: "log", text: "${secrets.K}" }] },
      stepsPrefix: [{ type: "log", text: "${secrets.K}" }],
      stepsSuffix: [{ type: "log", text: "${secrets.K}" }],
    };
    const t = fillJobPlaceholders(parts, {}, { K: "v" }, trusted).parts;
    expect(t).toEqual({
      scenario: { steps: [{ type: "log", text: "v" }] },
      stepsPrefix: [{ type: "log", text: "v" }],
      stepsSuffix: [{ type: "log", text: "v" }],
    });
    const u = fillJobPlaceholders(parts, {}, { K: "v" }, untrusted).parts;
    expect(u.scenario).toEqual({ steps: [{ type: "log", text: "${secrets.K}" }] });
    expect(u.stepsPrefix).toEqual([{ type: "log", text: "v" }]);
    expect(u.stepsSuffix).toEqual([{ type: "log", text: "v" }]);
  });

  it("fills ${config.*} everywhere, before ${secrets.*}", () => {
    const out = fillJobPlaceholders(
      { scenario: { url: "${config.url}" }, stepsPrefix: [{ type: "x", url: "${config.url}" }], stepsSuffix: undefined },
      { url: "https://${secrets.HOST}/a" }, { HOST: "h.example" }, trusted,
    );
    expect(out.parts.scenario).toEqual({ url: "https://h.example/a" });
    expect(out.parts.stepsPrefix).toEqual([{ type: "x", url: "https://h.example/a" }]);
  });

  it("a config value holding ${secrets.K} still cannot smuggle K into an untrusted eval set", () => {
    const filled = fillJobPlaceholders(
      { scenario: { steps: [{ type: "log", text: "${config.url}" }] }, stepsPrefix: undefined, stepsSuffix: undefined },
      { url: "${secrets.K}" }, { K: "v" }, untrusted,
    );
    expect(filled.parts.scenario).toEqual({ steps: [{ type: "log", text: "${secrets.K}" }] });
    expect(unresolvedSecretsError(filled, filled.parts, untrusted)).toMatch(/The eval set uses secret\(s\) K/);
  });

  it("leaves restful.request steps for Vox's server: not filled, not required", () => {
    const restful = { type: "restful.request", url: "https://x.example/${secrets.BROKERED}" };
    const filled = fillJobPlaceholders(
      { scenario: undefined, stepsPrefix: [restful, { type: "call.dial", number: "${secrets.P}" }], stepsSuffix: undefined },
      {}, { P: "+15551234" }, untrusted,
    );
    expect((filled.parts.stepsPrefix as unknown[])[0]).toEqual(restful);
    expect(filled.unsupplied).toEqual([]);
    expect(unresolvedSecretsError(filled, filled.parts, untrusted)).toBeNull();
  });
});

describe("unresolvedSecretsError", () => {
  it("names a secret the server did not supply", () => {
    const filled = fillJobPlaceholders(
      { scenario: undefined, stepsPrefix: [{ type: "call.dial", number: "${secrets.P}" }], stepsSuffix: undefined },
      {}, { OTHER: "x" }, untrusted,
    );
    expect(unresolvedSecretsError(filled, filled.parts, untrusted)).toMatch(/^Unresolved secret placeholder\(s\): P\./);
  });

  it("a secret whose VALUE contains ${secrets.X} is not mistaken for an unresolved one", () => {
    const filled = fillJobPlaceholders(
      { scenario: undefined, stepsPrefix: [{ type: "log", text: "${secrets.A}" }], stepsSuffix: undefined },
      {}, { A: "literally ${secrets.A}" }, untrusted,
    );
    expect(unresolvedSecretsError(filled, filled.parts, untrusted)).toBeNull();
  });

  it("a reference removed before the run (web session injection) no longer counts", () => {
    const filled = fillJobPlaceholders(
      { scenario: undefined, stepsPrefix: [{ type: "platform.setup", password: "${secrets.LOGIN}" }], stepsSuffix: undefined },
      {}, {}, untrusted,
    );
    expect(unresolvedSecretsError(filled, filled.parts, untrusted)).toMatch(/LOGIN/);
    const injected = { ...filled.parts, stepsPrefix: [{ type: "platform.setup", mode: "storage" }] };
    expect(unresolvedSecretsError(filled, injected, untrusted)).toBeNull();
  });
});

describe("jobConfigVars", () => {
  it("offers string config values, never the scenario or framework", () => {
    expect(jobConfigVars({ url: "u", scenario: "s", framework: "aeval", n: 3 })).toEqual({ url: "u" });
  });
});

describe("secretNeedles", () => {
  it("covers the raw value, its YAML-escaped form and its URL encoding", () => {
    const needles = secretNeedles({ K: 'a"b c' });
    expect(needles).toEqual(expect.arrayContaining(['a"b c', 'a\\"b c', "a%22b%20c"]));
  });
});

describe("scrubSecretsFromArtifacts", () => {
  it("removes secret values from text artifacts, in nested dirs, and leaves audio alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-"));
    fs.mkdirSync(path.join(dir, "dialf"));
    fs.writeFileSync(path.join(dir, "dialf", "steps.json"), JSON.stringify([{ type: "call.dial", number: "+12345952048" }]));
    fs.writeFileSync(path.join(dir, "notes.log"), "nothing secret here");
    const wav = Buffer.from("RIFF+12345952048");
    fs.writeFileSync(path.join(dir, "rx.wav"), wav);

    const changed = scrubSecretsFromArtifacts([dir], secretNeedles({ P: "+12345952048" }));

    expect(changed).toEqual([path.join(dir, "dialf", "steps.json")]);
    const steps = fs.readFileSync(path.join(dir, "dialf", "steps.json"), "utf-8");
    expect(steps).not.toContain("+12345952048");
    expect(steps).toContain("[redacted]");
    expect(fs.readFileSync(path.join(dir, "rx.wav")).equals(wav)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing without secrets", () => {
    expect(scrubSecretsFromArtifacts(["/nonexistent"], [])).toEqual([]);
  });
});

describe("phone end to end: filled Setup reaches DialF", () => {
  it("DialF's job.run dials the secret's value, not the placeholder", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-fill-"));
    const rx = path.join(tmp, "rx.wav");
    fs.writeFileSync(rx, "RIFF");
    const calls: Array<{ op: string; fields: any }> = [];
    const filled = fillJobPlaceholders(
      {
        scenario: { steps: [{ type: "audio.play", corpus_id: "known_q1" }] },
        stepsPrefix: parse("- type: call.dial\n  number: ${secrets.AGENT_PHONE}\n- type: call.wait_answered\n"),
        stepsSuffix: undefined,
      },
      {}, { AGENT_PHONE: "+1 234 595 2048" }, untrusted,
    );
    await runPhoneJob(
      {
        jobId: 1,
        prefixSteps: filled.parts.stepsPrefix as unknown[],
        scenarioSteps: (filled.parts.scenario as { steps: unknown[] }).steps,
        suffixSteps: [],
        resolveCorpusFile: (id) => `/abs/${id}.wav`,
      },
      {
        dialfCall: async (op, fields) => {
          calls.push({ op, fields });
          return { steps: [], recording: { mix: rx, t0_epoch_ms: 1 }, call: { end_reason: "completed" } };
        },
        executeRestful: async () => {},
        safetyHangup: async () => {},
        analyze: async () => {},
        parseMetrics: () => ({ responseLatencyMedian: 1 }),
        workDir: path.join(tmp, "session"),
      } as any,
    );
    expect(calls[0].fields.steps[0]).toMatchObject({ type: "call.dial", number: "+1 234 595 2048" });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
