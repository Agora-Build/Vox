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
    id: "integrations",
    title: "Data attribution",
    description: "Open geolocation data used by Vox. The active source depends on the deployment's configuration.",
    projects: [
      { name: "DB-IP", url: "https://db-ip.com/", description: "IP geolocation data created by DB-IP, available from https://db-ip.com. Vox uses DB-IP Lite as its GeoIP fallback.", notice: { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } },
    ],
  },
];
