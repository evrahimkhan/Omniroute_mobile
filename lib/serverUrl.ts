/**
 * The gateway URL, and which scheme a bare host should get.
 *
 * The app talks to either a public domain (https) or something on this device
 * or this Wi-Fi (plain http). Typing `127.0.0.1:20128` — or `192.168.1.10:20128`
 * — is the natural thing to do, and quietly making it `https://` is not a small
 * mistake: the request dies in the TLS handshake, `fetch` reports only
 * "Network error", Android's WebView reports only ERR_SSL_PROTOCOL_ERROR, and
 * neither says which URL was tried. That is exactly how a working local gateway
 * looks unreachable.
 *
 * So the scheme is decided by the host, not by a blanket default:
 *
 *   - loopback, the RFC 1918 ranges, link-local, mDNS/`.lan`/`.home.arpa` names
 *     and single-label hostnames → http. A phone's own gateway has no
 *     certificate to offer and no way to be trusted with one.
 *   - anything else — a domain, a tunnel — → https.
 *
 * An explicit scheme is always kept. If someone really does run an https
 * reverse proxy on their LAN, they can say so and this never argues.
 */

/** This device, in every spelling a URL can carry it. */
const LOOPBACK =
  /^(?:localhost|::1|0\.0\.0\.0|127(?:\.\d{1,3}){3}|::ffff:127(?:\.\d{1,3}){3})$/i;

/** The private IPv4 ranges (RFC 1918) plus link-local: same Wi-Fi, no TLS. */
const PRIVATE_V4 =
  /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/;

/** Names that only resolve inside a network: mDNS, the reserved home.arpa, and
 *  the private suffixes people actually use. */
const INTERNAL_NAME = /\.(?:local|localhost|lan|internal|home|localdomain|home\.arpa)$/i;

/** A hostname with no dot cannot be a public name — it is this LAN. */
const SINGLE_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Strip an authority (`host:port`, `[::1]:port`, `user@host:port`) down to its
 * host. A malformed literal is returned as-is: guessing about a typo is worse
 * than treating it as a name.
 */
function hostOfAuthority(authority: string): string {
  const hostPort = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;
  const withoutPort = /^\[[^\]]*\]:\d+$/.test(hostPort) || /^[^:]*:\d+$/.test(hostPort)
    ? hostPort.replace(/:\d+$/, '')
    : hostPort;
  return withoutPort.replace(/^\[|\]$/g, '');
}

/** True for a host the gateway is almost certainly speaking plain http on. */
export function isLocalHost(host: string): boolean {
  return (
    LOOPBACK.test(host) ||
    PRIVATE_V4.test(host) ||
    INTERNAL_NAME.test(host) ||
    SINGLE_LABEL.test(host)
  );
}

/** The scheme to use for input that did not name one. */
export function assumedScheme(raw: string): 'http' | 'https' {
  const authority = raw.trim().split(/[/?#]/)[0];
  const host = hostOfAuthority(authority);
  return host && isLocalHost(host) ? 'http' : 'https';
}

/**
 * Trim, add the scheme the host implies, and drop trailing slashes.
 */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `${assumedScheme(url)}://${url}`;
  return url.replace(/\/+$/, '');
}

/**
 * Repair a *saved* URL that can only be wrong: https to loopback.
 *
 * This is not hypothetical — until the scheme rule above existed, typing
 * `127.0.0.1:20128` was stored as `https://127.0.0.1:20128`, and every launch
 * after that failed the TLS handshake before anything could correct it. A
 * loopback address has no certificate and no way to be trusted with one, so
 * https there is always a mistake; an https gateway on `192.168.x.y` is unusual
 * but possible (a proxy with a private CA), so those are left alone.
 */
export function repairServerUrl(saved: string): string {
  const normalized = normalizeServerUrl(saved);
  const match = /^https:\/\/([^/?#]+)/i.exec(normalized);
  if (!match) return normalized;
  const host = hostOfAuthority(match[1]);
  return host && LOOPBACK.test(host) ? `http://${normalized.slice('https://'.length)}` : normalized;
}
