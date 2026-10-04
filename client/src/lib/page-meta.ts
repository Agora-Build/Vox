import { useEffect } from "react";
import { useLocation } from "wouter";

const SITE = "https://vox.agora.build";

interface PageMeta {
  title: string;
  description: string;
}

// index.html carries the home page's tags, which is what crawlers that don't
// run JavaScript (and every link-preview bot) see. Google renders the app, so
// these per-page values are what lets each public page rank for its own terms.
const DEFAULT: PageMeta = {
  title: "Vox — Voice AI Agent Evaluation & Latency Benchmark",
  description:
    "Vox for every engagement. Real-time evaluation of conversational AI voice agents: turn success rate, response and interrupt latency, on web and phone worldwide.",
};

const PUBLIC_PAGES: Record<string, PageMeta> = {
  "/": DEFAULT,
  "/realtime": {
    title: "Real-time Voice AI Latency Dashboard | Vox",
    description:
      "Live response latency, interrupt latency and turn success rate for Agora ConvoAI, LiveKit Agents and ElevenLabs Agents, measured every 3 hours in five regions.",
  },
  "/leaderboard": {
    title: "Voice AI Agent Leaderboard: Agora, LiveKit, ElevenLabs | Vox",
    description:
      "Rank conversational AI voice agents by region on six metrics: turn success, response and interrupt latency, network resilience, naturalness, noise reduction.",
  },
  "/dive": {
    title: "Voice AI Provider Deep Dive | Vox",
    description:
      "How each conversational AI voice platform performs region by region: latency distributions, turn success and trends over time.",
  },
  "/clash": {
    title: "Clash: Head-to-Head Voice AI Agent Duels | Vox",
    description:
      "Two AI voice agents debate live on the same topic. Watch, listen, and compare latency and Elo ratings.",
  },
  "/run-your-own": {
    title: "Test Your Own Voice AI Agent | Vox",
    description:
      "Run the same latency and turn-success evals against your own conversational AI agent, on web or over the phone.",
  },
  "/api-docs": {
    title: "Vox API — Voice AI Agent Evaluation REST API",
    description:
      "Create eval flows, run them against your voice agents, and read latency and turn-success results over HTTP with an API key.",
  },
  "/privacy": { title: "Privacy Policy | Vox", description: DEFAULT.description },
  "/thanks": {
    title: "Thanks | Vox",
    description:
      "Meet the open-source projects, libraries, and open data that make Vox possible. Thank you to their maintainers and communities.",
  },
  "/terms": { title: "Terms of Use | Vox", description: DEFAULT.description },
};

function setMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Keeps the document title and search/social tags in step with the route. */
export function usePageMeta() {
  const [path] = useLocation();

  useEffect(() => {
    const page = PUBLIC_PAGES[path];
    if (!page) {
      // Console, login, admin, and per-item pages: not for search results.
      document.title = "Vox";
      setMeta("name", "robots", "noindex, nofollow");
      return;
    }

    const url = `${SITE}${path === "/" ? "/" : path}`;
    document.title = page.title;
    setMeta("name", "robots", "index, follow, max-image-preview:large");
    setMeta("name", "description", page.description);
    setMeta("property", "og:title", page.title);
    setMeta("property", "og:description", page.description);
    setMeta("property", "og:url", url);
    setMeta("name", "twitter:title", page.title);
    setMeta("name", "twitter:description", page.description);
    document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", url);
  }, [path]);
}
