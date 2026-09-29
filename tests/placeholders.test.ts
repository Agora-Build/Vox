import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import yaml from "js-yaml";
import {
  fillJobPlaceholders, unresolvedSecretsError, secretNeedles, scrubSecretsFromArtifacts, jobConfigVars,
  shortSecretsError, createRedactingLineLogger, MIN_REDACT_LENGTH,
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

describe("FilledJob.used — only secrets actually filled are redacted", () => {
  it("lists secrets filled into Setup/Teardown (directly or through ${config.*}); not unsupplied ones, not an untrusted eval set's", () => {
    const filled = fillJobPlaceholders(
      {
        scenario: { steps: [{ type: "log", text: "${secrets.IN_SET}" }] },
        stepsPrefix: [{ type: "call.dial", number: "${secrets.PHONE}" }, { type: "x", url: "${config.url}" }],
        stepsSuffix: [{ type: "log", text: "${secrets.MISSING}" }],
      },
      { url: "https://${secrets.HOST}/" },
      { PHONE: "+15551234", HOST: "h.example", IN_SET: "set-value", UNUSED: "1" },
      untrusted,
    );
    expect(filled.used.sort()).toEqual(["HOST", "PHONE"]);
    expect(filled.unsupplied).toEqual(["MISSING"]);
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

  it("a job using a secret that can't be kept out of logs is refused — names only, never the value", () => {
    expect(shortSecretsError({ PIN: "123", LONG: "abcdef" })).toBe(
      `Secret(s) PIN can't be kept out of logs, errors and artifacts: a value, and each line of it that ` +
      `contains letters or digits, must be at least ${MIN_REDACT_LENGTH} characters. Update it under Console → Secrets.`,
    );
    // Stored before the line rule: each line would be logged on its own.
    expect(shortSecretsError({ A: "1", MULTI: "A\nB\nC\nD" })).toMatch(/^Secret\(s\) A, MULTI can't be kept out/);
    expect(shortSecretsError({ OK: "1234", JSON: '{\n  "k": "value-1"\n}' })).toBeNull();
  });
});

describe("scrubSecretsFromArtifacts", () => {
  const SECRET = "+12345952048";
  const needles = secretNeedles({ P: SECRET });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scrub-"));

  it("redacts text artifacts in nested dirs, and leaves a recording without the secret alone", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "dialf"));
    fs.writeFileSync(path.join(dir, "dialf", "steps.json"), JSON.stringify([{ type: "call.dial", number: SECRET }]));
    fs.writeFileSync(path.join(dir, "notes.log"), "nothing secret here");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(64), Buffer.from("audio")]);
    fs.writeFileSync(path.join(dir, "rx.wav"), wav);

    const out = scrubSecretsFromArtifacts([dir], needles);

    expect(out).toEqual({ changed: [path.join(dir, "dialf", "steps.json")], deleted: [], failed: [] });
    const steps = fs.readFileSync(path.join(dir, "dialf", "steps.json"), "utf-8");
    expect(steps).not.toContain(SECRET);
    expect(steps).toContain("[redacted]");
    expect(fs.readFileSync(path.join(dir, "rx.wav")).equals(wav)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("decides text by content, not file name: extensionless and .xml/.js text is redacted too", () => {
    const dir = tmp();
    for (const name of ["trace", "report.xml", "page.js"]) fs.writeFileSync(path.join(dir, name), `x ${SECRET} y`);
    const out = scrubSecretsFromArtifacts([dir], needles);
    expect(out.changed.sort()).toEqual(["page.js", "report.xml", "trace"].map((n) => path.join(dir, n)));
    for (const name of ["trace", "report.xml", "page.js"]) {
      expect(fs.readFileSync(path.join(dir, name), "utf-8")).toBe("x [redacted] y");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deletes a binary file that contains a secret — it cannot be redacted safely", () => {
    const dir = tmp();
    const bin = path.join(dir, "blob.bin");
    fs.writeFileSync(bin, Buffer.concat([Buffer.alloc(16), Buffer.from(SECRET), Buffer.alloc(16)]));
    expect(scrubSecretsFromArtifacts([dir], needles)).toEqual({ changed: [bin], deleted: [bin], failed: [] });
    expect(fs.existsSync(bin)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scans a large binary in chunks — a secret straddling a chunk boundary is still found", () => {
    const dir = tmp();
    const bin = path.join(dir, "big.bin");
    const at = 1024 * 1024 - 5; // the 1 MiB scan chunk splits the needle
    const buf = Buffer.alloc(3 * 1024 * 1024);
    Buffer.from(SECRET).copy(buf, at);
    fs.writeFileSync(bin, buf);
    expect(scrubSecretsFromArtifacts([dir], needles).deleted).toEqual([bin]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never deletes a recording, even if its samples happen to contain a secret's bytes", () => {
    const dir = tmp();
    const wav = path.join(dir, "rx.wav");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "latin1");
    header.write("WAVE", 8, "latin1");
    fs.writeFileSync(wav, Buffer.concat([header, Buffer.alloc(8), Buffer.from(SECRET), Buffer.alloc(8)]));
    expect(scrubSecretsFromArtifacts([dir], needles)).toEqual({ changed: [], deleted: [], failed: [] });
    expect(fs.existsSync(wav)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("redacts text byte-for-byte: bytes that are not valid UTF-8 survive", () => {
    const dir = tmp();
    const f = path.join(dir, "raw.log");
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), Buffer.from(` ${SECRET} é`)]));
    scrubSecretsFromArtifacts([dir], needles);
    expect(fs.readFileSync(f).equals(Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), Buffer.from(" [redacted] é")]))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("redacts a multi-line secret written re-indented into a text artifact", () => {
    const dir = tmp();
    const f = path.join(dir, "scenario.yaml");
    fs.writeFileSync(f, "creds: |\n    first-line-secret\n    second-line-secret\n");
    scrubSecretsFromArtifacts([dir], secretNeedles({ C: "first-line-secret\nsecond-line-secret" }));
    expect(fs.readFileSync(f, "utf-8")).toBe("creds: |\n    [redacted]\n    [redacted]\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed: a file it can neither rewrite nor remove is reported, never skipped", () => {
    if (process.getuid?.() === 0) return; // root ignores the permission this relies on
    const dir = tmp();
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    const f = path.join(locked, "out.json");
    fs.writeFileSync(f, `{"n":"${SECRET}"}`);
    fs.chmodSync(f, 0o444);
    fs.chmodSync(locked, 0o555);
    try {
      expect(scrubSecretsFromArtifacts([dir], needles).failed).toEqual([f]);
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing without secrets", () => {
    expect(scrubSecretsFromArtifacts(["/nonexistent"], [])).toEqual({ changed: [], deleted: [], failed: [] });
  });
});

describe("createRedactingLineLogger — aeval output reaches the agent's logs redacted", () => {
  const run = (chunks: string[], values: string[]) => {
    const lines: string[] = [];
    const log = createRedactingLineLogger((l) => lines.push(l), values);
    for (const c of chunks) log.write(c);
    log.flush();
    return lines;
  };

  it("redacts a secret split across output chunks", () => {
    expect(run(["dialing +1234", "5952048 now\nnext line\n"], secretNeedles({ P: "+12345952048" })))
      .toEqual(["dialing [redacted] now", "next line"]);
  });

  it("redacts each line of a multi-line secret, and flushes a last line without a newline", () => {
    const pem = "-----BEGIN KEY-----\nMIIEvQIBADANBg\n-----END KEY-----";
    expect(run(["key: -----BEGIN KEY-----\n", "MIIEvQIBADANBg\n", "tail"], secretNeedles({ K: pem })))
      .toEqual(["key: [redacted]", "[redacted]", "tail"]);
  });

  it("redacts a multi-line secret echoed re-indented, line by line (YAML block scalar)", () => {
    const key = "-----BEGIN KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END KEY-----";
    const echoed = ["key: |", "  -----BEGIN KEY-----", "  MIIEvQIBADANBg", "  kqhkiG9w0BAQEF", "  -----END KEY-----", ""].join("\n");
    const lines = run([echoed], secretNeedles({ K: key }));
    expect(lines.join("\n")).not.toMatch(/MIIEvQIBADANBg|kqhkiG9w0BAQEF|BEGIN KEY/);
    expect(lines).toEqual(["key: |", "[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
  });

  it("with no secrets it passes lines through", () => {
    expect(run(["a\r\nb"], [])).toEqual(["a", "b"]);
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
