import { describe, expect, it } from "vitest";
import { compare, discordDestination, render, ruleSchema } from "../plugins/notifications/configuration";
import { evaluateJavascript } from "../plugins/notifications/server/evaluate";

const snapshot = { metrics: { "credits.available": 12 }, samples: [{ id: 1, at: "2026-10-04T00:00:00Z", values: { latency: 200 } }] };
describe("notification rules and sandbox", () => {
  it.each([
    ["<", 10, 11, true], ["<=", 10, 10, true], ["=", 10, 10, true], ["!=", 10, 11, true], [">=", 10, 10, true], [">", 11, 10, true],
    ["<", null, 10, false], ["!=", null, 10, false], [">", Number.NaN, 10, false], ["=", 11, 10, false],
  ])("compares %s safely", (operator, left, right, expected) => {
    expect(compare(left as number | null, operator as string, right as number)).toBe(expected);
  });
  it("renders a bounded set of placeholders as plain text", () => {
    expect(render("Hi {{ username }}: {{credits.available}} {{missing}}", { username: "<b>Example</b>", "credits.available": 12 })).toBe("Hi <b>Example</b>: 12 N/A");
  });
  it("accepts only fixed official Discord destinations", () => {
    const path = `/api/webhooks/12345678901234567890/${"x".repeat(80)}`;
    expect(discordDestination(`https://discord.com${path}`)).toBe(`https://discord.com${path}`);
    for (const url of [`http://discord.com${path}`, `https://discord.com.evil.test${path}`, `https://127.0.0.1${path}`, `https://user:pass@discord.com${path}`, `https://discord.com${path}?redirect=x`, "https://discord.com/api/users/@me"]) expect(() => discordDestination(url)).toThrow();
  });
  it("loads the supplied snapshot and returns a structured calculation", async () => {
    expect(await evaluateJavascript('const rows = loadData().samples; return {matched: data.metrics["credits.available"] < 20 && latest.values.latency === 200, summary: String(rows.length)};', snapshot)).toEqual({ matched: true, summary: "1" });
  });
  it("has no host APIs, dynamic imports or secrets", async () => {
    expect(await evaluateJavascript('return {matched: true, summary: [typeof process, typeof require, typeof fetch, typeof global, typeof XMLHttpRequest].join(",")};', snapshot)).toEqual({ matched: true, summary: "undefined,undefined,undefined,undefined,undefined" });
    await expect(evaluateJavascript('return import("node:fs");', snapshot)).rejects.toThrow();
  });
  it("does not let one rule modify another rule's data", async () => {
    await evaluateJavascript('data.metrics["credits.available"] = 0; return true;', snapshot);
    expect(snapshot.metrics["credits.available"]).toBe(12);
    expect((await evaluateJavascript('return data.metrics["credits.available"] === 12;', snapshot)).matched).toBe(true);
  });
  it("interrupts infinite loops, excessive memory and runaway result getters", async () => {
    await expect(evaluateJavascript("while (true) {}", snapshot)).rejects.toThrow(/resource limits/);
    await expect(evaluateJavascript("const rows = []; while (true) rows.push('x'.repeat(4096));", snapshot)).rejects.toThrow(/resource limits/);
    await expect(evaluateJavascript("return { get matched() { while(true) {} } };", snapshot)).rejects.toThrow(/resource limits/);
  });
  it.each(["return 1;", "return Promise.resolve(true);", 'return {matched: true, summary: "x".repeat(2000)};', 'return {matched: "yes"};'])("rejects invalid output: %s", async (code) => {
    await expect(evaluateJavascript(code, snapshot)).rejects.toThrow();
  });
  it("enforces rule bounds and LLM minimum interval", () => {
    const definition = { name: "Example", audience: { type: "user", userId: 1 }, condition: { type: "llm", prompt: "Analyze the numeric data." }, channelIds: ["cf227aa0-4fe7-4e16-af58-c4bc35e6c4aa"], subject: "Alert", message: "{{result}}", intervalSeconds: 300, cooldownSeconds: 300 };
    expect(ruleSchema.safeParse(definition).success).toBe(false);
    expect(ruleSchema.safeParse({ ...definition, intervalSeconds: 900 }).success).toBe(true);
    expect(ruleSchema.safeParse({ ...definition, intervalSeconds: 900, audience: { type: "user", userId: -1 } }).success).toBe(false);
  });
});
