/** A stable logical site identifier and the hostnames that belong to it. */
export interface SiteProfile {
  readonly siteKey: string;
  readonly domains: readonly string[];
}

/**
 * Site profiles shared by the built-in adapters.
 *
 * The site key is intentionally independent from the hostname.  A hostname
 * may be added here later without changing existing thread IDs.
 */
export const KNOWN_SITE_PROFILES: readonly SiteProfile[] = Object.freeze([
  Object.freeze({
    siteKey: "@5ch",
    domains: Object.freeze(["5ch.net", "5ch.io", "2ch.net"]),
  }),
  Object.freeze({
    siteKey: "@bbspink",
    domains: Object.freeze(["bbspink.com"]),
  }),
  Object.freeze({
    siteKey: "@open2ch",
    domains: Object.freeze(["open2ch.net"]),
  }),
  Object.freeze({
    siteKey: "@machi",
    domains: Object.freeze(["machi.to"]),
  }),
  Object.freeze({
    siteKey: "@shitaraba",
    domains: Object.freeze(["jbbs.shitaraba.net"]),
  }),
]);

/**
 * Converts a URL or hostname to the site key used in shared thread IDs.
 *
 * Known sites use their stable @-prefixed key, including when the input is a
 * subdomain. Unknown sites use the normalized hostname, including its
 * subdomain. Scheme, path, query, fragment, credentials, and port are not
 * part of a site key.
 */
export function normalizeSiteKey(
  urlOrHostname: string,
  profiles: readonly SiteProfile[] = KNOWN_SITE_PROFILES,
): string {
  const hostname = normalizeHostname(urlOrHostname);
  const profile = profiles.find((candidate) =>
    candidate.domains.some((domain) => isSameOrSubdomain(hostname, normalizeDomain(domain))),
  );
  return profile?.siteKey ?? hostname;
}

/** Returns the canonical hostname from a URL or a hostname-like input. */
export function normalizeHostname(urlOrHostname: string): string {
  if (typeof urlOrHostname !== "string" || urlOrHostname.trim().length === 0) {
    throw new TypeError("urlOrHostname must be a non-empty string");
  }

  const input = urlOrHostname.trim();
  let url: URL;
  try {
    url = new URL(hasScheme(input) ? input : `http://${input}`);
  } catch {
    throw new TypeError(`invalid URL or hostname: ${urlOrHostname}`);
  }

  if (url.hostname.length === 0) {
    throw new TypeError(`invalid URL or hostname: ${urlOrHostname}`);
  }

  return normalizeDomain(url.hostname);
}

function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.$/, "");
}

function isSameOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
