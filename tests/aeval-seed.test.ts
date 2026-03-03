/**
 * Tests for server/aeval-seed.ts — Auto-seeding of built-in aeval data
 *
 * Tests cover:
 * - compareVersions: semver comparison logic
 * - discoverScenarios: filesystem YAML discovery
 * - seedFromLocalAevalData: version parsing from release notes
 * - Scenario metadata extraction (name, description, yamlContent)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { compareVersions, discoverScenarios } from "../server/aeval-seed";

// ---------------------------------------------------------------------------
// compareVersions (actual import, not mirror)
// ---------------------------------------------------------------------------

describe("aeval-seed — compareVersions", () => {
  it("should return 0 for equal versions", () => {
    expect(compareVersions("v0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("should handle v prefix mismatch", () => {
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
  });

  it("should handle case-insensitive V prefix", () => {
    expect(compareVersions("V1.0.0", "v1.0.0")).toBe(0);
  });

  it("should compare major versions", () => {
    expect(compareVersions("v2.0.0", "v1.0.0")).toBe(1);
    expect(compareVersions("v1.0.0", "v2.0.0")).toBe(-1);
  });

  it("should compare minor versions", () => {
    expect(compareVersions("v0.2.0", "v0.1.0")).toBe(1);
    expect(compareVersions("v0.1.0", "v0.2.0")).toBe(-1);
  });

  it("should compare patch versions", () => {
    expect(compareVersions("v0.1.2", "v0.1.1")).toBe(1);
    expect(compareVersions("v0.1.1", "v0.1.2")).toBe(-1);
  });

  it("should handle different segment counts (padding with 0)", () => {
    expect(compareVersions("v1.0", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.1", "v1.0")).toBe(1);
    expect(compareVersions("v1", "v1.0.0")).toBe(0);
  });

  it("should handle double-digit version numbers", () => {
    expect(compareVersions("v0.10.0", "v0.9.0")).toBe(1);
    expect(compareVersions("v0.9.0", "v0.10.0")).toBe(-1);
  });

  it("should work for version-gating: agent too old for job", () => {
    // Job requires v0.2.0, agent has v0.1.0 → job version > agent version
    expect(compareVersions("v0.2.0", "v0.1.0")).toBe(1);
  });

  it("should work for version-gating: exact match", () => {
    expect(compareVersions("v0.1.0", "v0.1.0")).toBe(0);
  });

  it("should work for version-gating: agent newer than job", () => {
    expect(compareVersions("v0.1.0", "v0.2.0")).toBe(-1);
  });

  it("should treat non-numeric segments as 0", () => {
    // "beta" parsed by parseInt yields NaN → || 0
    expect(compareVersions("v0.1.0-beta", "v0.1.0")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// discoverScenarios
// ---------------------------------------------------------------------------

describe("aeval-seed — discoverScenarios", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-seed-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty array for nonexistent path", () => {
    const result = discoverScenarios("/nonexistent/path/aeval-data");
    expect(result).toEqual([]);
  });

  it("should return empty when examples/ does not exist", () => {
    const dataDir = path.join(tmpDir, "no-examples");
    fs.mkdirSync(dataDir, { recursive: true });
    const result = discoverScenarios(dataDir);
    expect(result).toEqual([]);
  });

  it("should discover YAML files from category directories", () => {
    const dataDir = path.join(tmpDir, "with-examples");
    const responseDir = path.join(dataDir, "examples", "response");
    fs.mkdirSync(responseDir, { recursive: true });

    fs.writeFileSync(
      path.join(responseDir, "test_R00_en.yaml"),
      "---\nname: test_R00_en\ndescription: A simple test\nsteps:\n  - type: audio.play\n",
    );

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("response");
    expect(result[0].filename).toBe("test_R00_en.yaml");
    expect(result[0].name).toBe("test_R00_en");
    expect(result[0].description).toBe("A simple test");
    expect(result[0].yamlContent).toContain("audio.play");
  });

  it("should discover .yml files too", () => {
    const dataDir = path.join(tmpDir, "yml-ext");
    const catDir = path.join(dataDir, "examples", "interrupt");
    fs.mkdirSync(catDir, { recursive: true });

    fs.writeFileSync(path.join(catDir, "test.yml"), "name: yml_test\nsteps: []");

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("yml_test");
  });

  it("should skip non-directory entries in examples/", () => {
    const dataDir = path.join(tmpDir, "mixed-entries");
    const examplesDir = path.join(dataDir, "examples");
    fs.mkdirSync(examplesDir, { recursive: true });

    // A file directly in examples/ (not a directory)
    fs.writeFileSync(path.join(examplesDir, "README.md"), "# README");

    // A proper category directory
    const catDir = path.join(examplesDir, "response");
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(path.join(catDir, "test.yaml"), "name: test_file\nsteps: []");

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("response");
  });

  it("should fall back to filename when name field is missing from YAML", () => {
    const dataDir = path.join(tmpDir, "no-name-field");
    const catDir = path.join(dataDir, "examples", "response");
    fs.mkdirSync(catDir, { recursive: true });

    fs.writeFileSync(
      path.join(catDir, "unnamed_scenario.yaml"),
      "steps:\n  - type: audio.play\n",
    );

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("unnamed_scenario");
  });

  it("should fall back to empty string when description is missing", () => {
    const dataDir = path.join(tmpDir, "no-desc");
    const catDir = path.join(dataDir, "examples", "response");
    fs.mkdirSync(catDir, { recursive: true });

    fs.writeFileSync(path.join(catDir, "nodesc.yaml"), "name: nodesc\nsteps: []");

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("");
  });

  it("should discover scenarios across multiple categories", () => {
    const dataDir = path.join(tmpDir, "multi-cat");
    const exDir = path.join(dataDir, "examples");

    for (const cat of ["response", "interrupt", "multi_turn_dialogue"]) {
      const catDir = path.join(exDir, cat);
      fs.mkdirSync(catDir, { recursive: true });
      fs.writeFileSync(path.join(catDir, `${cat}_01.yaml`), `name: ${cat}_01\nsteps: []`);
    }

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(3);
    const categories = result.map((r) => r.category).sort();
    expect(categories).toEqual(["interrupt", "multi_turn_dialogue", "response"]);
  });

  it("should store full YAML content verbatim", () => {
    const dataDir = path.join(tmpDir, "full-content");
    const catDir = path.join(dataDir, "examples", "response");
    fs.mkdirSync(catDir, { recursive: true });

    const yamlContent = `---\nname: verbatim_test\ndescription: Full content test\nanalysis:\n  preset: config/default.yaml\nsteps:\n  - type: audio.play\n    corpus_id: test\n`;
    fs.writeFileSync(path.join(catDir, "verbatim.yaml"), yamlContent);

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].yamlContent).toBe(yamlContent);
  });

  it("should skip non-YAML files in category directories", () => {
    const dataDir = path.join(tmpDir, "non-yaml");
    const catDir = path.join(dataDir, "examples", "response");
    fs.mkdirSync(catDir, { recursive: true });

    fs.writeFileSync(path.join(catDir, "valid.yaml"), "name: valid\nsteps: []");
    fs.writeFileSync(path.join(catDir, "readme.md"), "# not a yaml");
    fs.writeFileSync(path.join(catDir, "data.json"), '{"not": "yaml"}');

    const result = discoverScenarios(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("valid.yaml");
  });
});

// ---------------------------------------------------------------------------
// discoverScenarios with real aeval-data (smoke test)
// ---------------------------------------------------------------------------

describe("aeval-seed — discoverScenarios with real aeval-data", () => {
  const aevalDataPath = path.resolve(__dirname, "..", "vox_eval_agentd", "aeval-data");

  it("should discover scenarios from actual aeval-data/examples if available", () => {
    if (!fs.existsSync(path.join(aevalDataPath, "examples"))) {
      // Skip if aeval-data submodule not checked out
      return;
    }

    const result = discoverScenarios(aevalDataPath);
    expect(result.length).toBeGreaterThan(0);

    // Every result should have category, filename, yamlContent
    for (const s of result) {
      expect(s.category).toBeTruthy();
      expect(s.filename).toMatch(/\.ya?ml$/);
      expect(s.yamlContent.length).toBeGreaterThan(0);
    }

    // Should have at least response and interrupt categories
    const categories = new Set(result.map((r) => r.category));
    expect(categories.has("response")).toBe(true);
    expect(categories.has("interrupt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Version parsing from LATEST_RELEASE_NOTES.md
// ---------------------------------------------------------------------------

describe("aeval-seed — version parsing from release notes", () => {
  it("should extract version from standard header format", () => {
    const content = "# aeval v0.1.0\n\nBuilt: 2026-03-01\n";
    const match = content.match(/^#\s+aeval\s+(v[\d.]+)/m);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("v0.1.0");
  });

  it("should extract version from real LATEST_RELEASE_NOTES.md", () => {
    const releaseNotesPath = path.resolve(
      __dirname,
      "..",
      "vox_eval_agentd",
      "aeval-data",
      "release",
      "LATEST_RELEASE_NOTES.md",
    );

    if (!fs.existsSync(releaseNotesPath)) return; // Skip if not available

    const content = fs.readFileSync(releaseNotesPath, "utf-8");
    const match = content.match(/^#\s+aeval\s+(v[\d.]+)/m);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("should return null for content without version", () => {
    const content = "# Some Other Document\n\nNo version here.\n";
    const match = content.match(/^#\s+aeval\s+(v[\d.]+)/m);
    expect(match).toBeNull();
  });

  it("should handle version in non-first line", () => {
    const content = "Some preamble text\n# aeval v2.3.4\nMore content\n";
    const match = content.match(/^#\s+aeval\s+(v[\d.]+)/m);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("v2.3.4");
  });
});
