/**
 * Returns the canonical server hostname from a URL or a hostname-like input.
 *
 * The normalized hostname is used directly in thread IDs and filter scopes.
 * There is deliberately no alias layer: different servers remain different
 * identifiers so that a client can restore the original server without
 * reconstructing it from a logical name.
 */
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
