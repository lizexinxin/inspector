/**
 * A connection-scoped cookie jar for the Inspector's HTTP transports.
 *
 * Multi-replica deployments are frequently put behind a load balancer that
 * routes by cookie affinity: the first response carries
 * `Set-Cookie: <affinity>=…` (name varies by deployment), and every later
 * request must replay it or the balancer may land on a replica that does not
 * hold the MCP session — after a successful `initialize`, the Inspector sees
 * `404 Session not found` on every subsequent request. A browser does this
 * automatically; `fetch` does not, and the transport fetch chains dropped
 * `Set-Cookie` entirely, so such a deployment could not be inspected.
 *
 * The jar is deliberately scoped, because the SDK hands this fetch to more
 * than the MCP endpoint:
 *
 * - **One jar per connection.** The wrapper is created with the transport and
 *   discarded with it — cookies never outlive the session they were issued
 *   for, and a reconnect re-learns affinity.
 * - **Same origin only.** Cookies are stored from responses on the server's
 *   origin and replayed only onto requests to that origin. OAuth discovery
 *   and token requests to other origins are neither read nor written.
 * - **Host-only, simplified RFC 6265.** `name=value` plus expiry (`Max-Age`,
 *   which wins, then `Expires`) is what a sticky cookie needs;
 *   `Domain`/`Path`/`Secure`/`HttpOnly` are ignored — every cookie is
 *   host-only with path `/`. A `Set-Cookie` without `=` or with an empty name
 *   is dropped silently: the jar is an affinity aid, not a compliance suite.
 * - **Bounded.** `MAX_COOKIES` entries per jar (oldest evicted first) and
 *   `MAX_COOKIE_BYTES` per entry keep a hostile server from growing it.
 *
 * The wrapper sits above the fetch tracker, so the Network log records the
 * headers actually sent (#2385); `Cookie` and `Set-Cookie` are already in the
 * log's redaction list, so stored values never surface there.
 */

/** Entries per jar before the oldest inserted cookie is evicted. */
export const MAX_COOKIES = 50;
/** Byte budget for a single stored `name=value` pair; larger is dropped. */
export const MAX_COOKIE_BYTES = 4096;

interface JarEntry {
  value: string;
  /** Absolute expiry from `Max-Age`/`Expires`, or `undefined` for a session cookie. */
  expiresAt: number | undefined;
}

export function createCookieJarFetch(
  baseFetch: typeof fetch,
  serverUrl: URL,
): typeof fetch {
  const origin = serverUrl.origin;
  // Map preserves insertion order, which is both the eviction order and the
  // serialization order.
  const jar = new Map<string, JarEntry>();

  return async (input, init) => {
    const url = requestUrl(input);
    const sameOrigin = url !== undefined && url.origin === origin;
    let sentInit = init;
    if (sameOrigin) {
      const cookie = serialize(jar);
      if (cookie !== undefined) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        const existing = headers.get("cookie");
        headers.set("cookie", existing ? `${existing}; ${cookie}` : cookie);
        sentInit = { ...init, headers };
      }
    }
    const response = await baseFetch(input, sentInit);
    if (sameOrigin) store(response.headers.getSetCookie(), jar);
    return response;
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  const raw =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function serialize(jar: Map<string, JarEntry>): string | undefined {
  const now = Date.now();
  const pairs: string[] = [];
  for (const [name, entry] of jar) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      jar.delete(name);
      continue;
    }
    pairs.push(`${name}=${entry.value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function store(lines: string[], jar: Map<string, JarEntry>): void {
  for (const line of lines) {
    const parsed = parseSetCookie(line);
    if (parsed === undefined) continue;
    if (!jar.has(parsed.name) && jar.size >= MAX_COOKIES) {
      // At capacity for a new name: drop the oldest inserted entry.
      // `MAX_COOKIES` ≥ 1, so the map cannot be empty here.
      jar.delete(jar.keys().next().value as string);
    }
    jar.set(parsed.name, { value: parsed.value, expiresAt: parsed.expiresAt });
  }
}

function parseSetCookie(
  line: string,
): { name: string; value: string; expiresAt: number | undefined } | undefined {
  const attrsStart = line.indexOf(";");
  const pair = (attrsStart === -1 ? line : line.slice(0, attrsStart)).trim();
  const eq = pair.indexOf("=");
  // `-1`: a bare token with no value; `0`: an empty name.
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name.length + value.length + 1 > MAX_COOKIE_BYTES) return undefined;
  return {
    name,
    value,
    expiresAt: expiryFromAttributes(
      attrsStart === -1 ? "" : line.slice(attrsStart + 1),
    ),
  };
}

function expiryFromAttributes(attrs: string): number | undefined {
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attr of attrs.split(";")) {
    const eq = attr.indexOf("=");
    const key = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? "" : attr.slice(eq + 1).trim();
    if (key === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) maxAge = Date.now() + seconds * 1000;
    } else if (key === "expires") {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) expires = time;
    }
  }
  // RFC 6265 §5.3: a valid `Max-Age` wins over `Expires`.
  return maxAge ?? expires;
}
