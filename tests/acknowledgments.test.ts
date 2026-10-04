import { describe, expect, it } from "vitest";
import { acknowledgmentGroups } from "../client/src/lib/acknowledgments";

describe("Thanks page acknowledgments", () => {
  it("has unique category anchors and project names", () => {
    const ids = acknowledgmentGroups.map((group) => group.id);
    const names = acknowledgmentGroups.flatMap((group) => group.projects.map((project) => project.name));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const group of acknowledgmentGroups) {
      expect(group.id).toMatch(/^[a-z]+$/);
      expect(group.title).not.toBe("");
      expect(group.description).not.toBe("");
      expect(group.projects.length).toBeGreaterThan(0);
    }
  });

  it("gives each project a description and a secure public link", () => {
    for (const { projects } of acknowledgmentGroups) {
      for (const project of projects) {
        const url = new URL(project.url);
        expect(url.protocol).toBe("https:");
        expect(url.username).toBe("");
        expect(url.password).toBe("");
        expect(project.description.length).toBeGreaterThan(20);
      }
    }
  });

  it("preserves the audio library and GeoIP data attribution links", () => {
    const projects = acknowledgmentGroups.flatMap((group) => group.projects);
    expect(projects.find((project) => project.name === "Mediabunny")?.notice?.url).toBe("/licenses/mediabunny.txt");
    const dbip = projects.find((project) => project.name === "DB-IP");
    expect(dbip?.description).toContain("IP geolocation data created by DB-IP");
    expect(dbip?.notice?.url).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(acknowledgmentGroups.find((group) => group.id === "integrations")?.description).toContain("not a list of services enabled on every deployment");
  });
});
