export const GEOIP_ATTRIBUTIONS = {
  dbip: {
    attribution: "IP Geolocation by DB-IP (db-ip.com), CC BY 4.0",
    dataName: "IP geolocation",
    provider: "DB-IP",
    url: "https://db-ip.com",
  },
  geolite2: {
    attribution: "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.",
    dataName: "GeoLite2",
    provider: "MaxMind",
    url: "https://www.maxmind.com",
  },
} as const;

export function geoipAttributionForSource(source: unknown): string | null {
  return source === "dbip" || source === "geolite2"
    ? GEOIP_ATTRIBUTIONS[source].attribution
    : null;
}
