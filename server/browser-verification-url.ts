const OUTLOOK_SAFE_LINKS_HOST = "safelinks.protection.outlook.com";
const CHECK_POINT_HOST = "protect.checkpoint.com";
const MAX_WRAPPERS = 4;

function httpsUrl(link: string): URL | null {
  // eslint-disable-next-line no-control-regex -- Reject controls the URL parser can silently remove.
  if (!/^https:\/\/[^/?#]/i.test(link) || /[\s\\\x00-\x1f\x7f]/.test(link)) return null;
  try {
    const url = new URL(link);
    return !url.username && !url.password ? url : null;
  } catch { return null; }
}

function decodeDestination(value: string): string | null {
  if (!/^https%3a%2f%2f/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return null; }
}

function queryDestinations(url: URL): Set<string> {
  const destinations = new Set<string>();
  url.searchParams.forEach((value) => {
    const candidate = decodeDestination(value);
    const parsed = candidate && httpsUrl(candidate);
    if (parsed) destinations.add(parsed.href);
  });
  return destinations;
}

export function hasEmbeddedVerificationUrl(link: string): boolean {
  const url = httpsUrl(link);
  return !!url && queryDestinations(url).size > 0;
}

/** Infer unknown wrappers only with a trusted sign-in origin. The engine still authorizes navigation. */
export function extractVerificationUrl(value: unknown, activeOrigin?: string): string | null {
  if (typeof value !== "string") return null;
  let link = value.trim();
  let inferred = false;
  for (let depth = 0; depth <= MAX_WRAPPERS; depth++) {
    const url = httpsUrl(link);
    if (!url) return null;

    if (url.hostname === OUTLOOK_SAFE_LINKS_HOST || url.hostname.endsWith(`.${OUTLOOK_SAFE_LINKS_HOST}`)) {
      const destinations = url.searchParams.getAll("url");
      if (url.port || destinations.length !== 1) return null;
      link = destinations[0];
    } else if (url.hostname === CHECK_POINT_HOST) {
      if (url.port) return null;
      // The embedded URL can contain ? and #, so extract from the full wrapper rather than pathname.
      const destination = link.match(/^https:\/\/[^/?#]+\/v2\/r\d+\/___(.+)___\.[\w-]+={0,2}$/i)?.[1];
      const decoded = destination && decodeDestination(destination);
      if (!decoded) return null;
      link = decoded;
    } else {
      if (!activeOrigin || url.origin === activeOrigin) return url.href;
      const candidates = queryDestinations(url);
      if (candidates.size === 0) return inferred ? null : url.href;
      if (candidates.size !== 1) return null;
      link = Array.from(candidates)[0];
      inferred = true;
    }
  }
  return null;
}
