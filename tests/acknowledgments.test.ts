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
    expect(acknowledgmentGroups.find((group) => group.id === "integrations")?.description).toContain("active source depends on the deployment's configuration");
  });

  it("excludes the requested commercial-company acknowledgments", () => {
    const names = acknowledgmentGroups.flatMap((group) => group.projects.map((project) => project.name));
    for (const name of ["Stripe", "Google", "Discord", "Anthropic", "MaxMind"]) {
      expect(names).not.toContain(name);
    }
  });

  it("omits the interface, platform, and building/shipping sections", () => {
    expect(acknowledgmentGroups.map((group) => group.id)).toEqual(["evaluation", "integrations"]);
    const names = acknowledgmentGroups.flatMap((group) => group.projects.map((project) => project.name));
    for (const name of ["React", "Wouter", "TanStack Query", "Tailwind CSS", "shadcn/ui", "Radix UI", "Lucide", "Recharts", "Node.js", "Express", "PostgreSQL", "Drizzle ORM", "Zod", "AWS SDK for JavaScript", "QuickJS / quickjs-emscripten", "Nodemailer", "OTPAuth", "TypeScript", "Vite", "Vitest", "Playwright", "Docker", "Coolify", "GitHub"]) {
      expect(names).not.toContain(name);
    }
  });
});
