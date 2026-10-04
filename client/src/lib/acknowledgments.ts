export interface AcknowledgedProject {
  name: string;
  url: string;
  description: string;
  notice?: { label: string; url: string };
}

export interface AcknowledgmentGroup {
  id: string;
  title: string;
  description: string;
  projects: AcknowledgedProject[];
}

// Curated from the dependencies and integrations in this repository, not an
// exhaustive license inventory or a claim about a deployment's configuration.
export const acknowledgmentGroups: AcknowledgmentGroup[] = [
  {
    id: "evaluation",
    title: "Evaluation & audio",
    description: "The projects behind our conversations, measurements, and recordings.",
    projects: [
      { name: "aeval", url: "https://github.com/Agora-Build/aeval", description: "Runs voice-agent evaluations and turns recorded conversations into metrics." },
      { name: "DialF", url: "https://github.com/Agora-Build/DialF", description: "Connects phone-mode evaluations to real calls and captures their audio." },
      { name: "Libretto", url: "https://github.com/Agora-Build/libretto", description: "The shared action-script protocol for evaluation setup and teardown." },
      { name: "FFmpeg", url: "https://ffmpeg.org/", description: "Audio conversion and processing in the evaluation agents and Clash runner." },
      { name: "Mediabunny", url: "https://mediabunny.dev/", description: "Reads compressed audio containers for genuine, multi-channel recording waveforms.", notice: { label: "MPL-2.0 license & source", url: "/licenses/mediabunny.txt" } },
    ],
  },
  {
    id: "interface",
    title: "The interface",
    description: "The foundations of the pages, charts, and controls you use every day.",
    projects: [
      { name: "React", url: "https://react.dev/", description: "The component model behind Vox's public pages and console." },
      { name: "Wouter", url: "https://github.com/molefrog/wouter", description: "Lightweight client-side routing between pages." },
      { name: "TanStack Query", url: "https://tanstack.com/query/latest", description: "Fetches, caches, and refreshes data from the Vox API." },
      { name: "Tailwind CSS", url: "https://tailwindcss.com/", description: "The styling system for responsive layouts and our light and dark themes." },
      { name: "shadcn/ui", url: "https://ui.shadcn.com/", description: "The reusable UI components adapted into Vox's design system." },
      { name: "Radix UI", url: "https://www.radix-ui.com/", description: "Accessible primitives for dialogs, menus, tabs, and other controls." },
      { name: "Lucide", url: "https://lucide.dev/", description: "The open-source icon family used throughout the site." },
      { name: "Recharts", url: "https://recharts.org/", description: "Visualizes evaluation trends, latency, and regional comparisons." },
    ],
  },
  {
    id: "platform",
    title: "The platform",
    description: "The libraries that help us store data, serve requests, and run safely.",
    projects: [
      { name: "Node.js", url: "https://nodejs.org/", description: "The JavaScript runtime for the server, agents, and brokers." },
      { name: "Express", url: "https://expressjs.com/", description: "HTTP routing and middleware for the Core API and plugin endpoints." },
      { name: "PostgreSQL", url: "https://www.postgresql.org/", description: "Stores evaluations, users, sessions, and plugin-owned data." },
      { name: "Drizzle ORM", url: "https://orm.drizzle.team/", description: "Typed database queries and shared schema definitions." },
      { name: "Zod", url: "https://zod.dev/", description: "Validates API inputs and shared data contracts." },
      { name: "AWS SDK for JavaScript", url: "https://github.com/aws/aws-sdk-js-v3", description: "Connects to S3-compatible storage for recordings and evaluation artifacts." },
      { name: "QuickJS / quickjs-emscripten", url: "https://github.com/justjake/quickjs-emscripten", description: "Isolated JavaScript execution for notification rules, with bounded resources." },
      { name: "Nodemailer", url: "https://nodemailer.com/", description: "SMTP delivery for configured email notification channels." },
      { name: "OTPAuth", url: "https://github.com/hectorm/otpauth", description: "Authenticator-compatible one-time codes for sensitive account actions." },
    ],
  },
  {
    id: "tooling",
    title: "Building & shipping",
    description: "The tools and services that help contributors develop, test, and deliver Vox.",
    projects: [
      { name: "TypeScript", url: "https://www.typescriptlang.org/", description: "Shared types and compile-time checks across the client, server, and agents." },
      { name: "Vite", url: "https://vite.dev/", description: "Local frontend development and production asset builds." },
      { name: "Vitest", url: "https://vitest.dev/", description: "Unit and integration tests for application behavior and security boundaries." },
      { name: "Playwright", url: "https://playwright.dev/", description: "Browser automation and end-to-end tests of real user interactions." },
      { name: "Docker", url: "https://www.docker.com/", description: "Container tooling for the app, agents, brokers, and isolated test environments." },
      { name: "Coolify", url: "https://coolify.io/", description: "Open-source deployment management used to host the Vox service." },
      { name: "GitHub", url: "https://github.com/", description: "Source hosting, community collaboration, CI workflows, and optional sign-in." },
    ],
  },
  {
    id: "integrations",
    title: "Data & optional services",
    description: "Supported integrations, not a list of services enabled on every deployment. Availability depends on plugins and configuration.",
    projects: [
      { name: "DB-IP", url: "https://db-ip.com/", description: "IP geolocation data created by DB-IP, available from https://db-ip.com. Vox uses DB-IP Lite as its GeoIP fallback.", notice: { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } },
      { name: "MaxMind", url: "https://www.maxmind.com/", description: "GeoLite2 city and network data for agent-region verification when configured." },
      { name: "Stripe", url: "https://stripe.com/", description: "Configured payment plugins use Stripe for checkout, top-ups, and subscriptions." },
      { name: "Google", url: "https://developers.google.com/identity", description: "Optional Google OAuth sign-in through the authentication plugin." },
      { name: "Discord", url: "https://discord.com/developers/docs/resources/webhook", description: "An optional webhook delivery channel for notification alerts." },
      { name: "Anthropic", url: "https://www.anthropic.com/", description: "Optional LLM analysis for notification rules when enabled and configured by an administrator." },
    ],
  },
];
