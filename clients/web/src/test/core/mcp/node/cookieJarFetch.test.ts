/**
 * Semantics of `createCookieJarFetch`: store `Set-Cookie` from same-origin
 * responses, replay as `Cookie` on later same-origin requests, expire on
 * `Max-Age`/`Expires`, overwrite by name, ignore other origins, and stay
 * bounded. The wrapper sits above the fetch tracker, so what it injects is
 * what the Network log records (#2385); `Cookie`/`Set-Cookie` are already in
 * the log's redaction list, so nothing stored here can surface there.
 *
 * One deliberate deviation from the planned verbatim file, in the same spirit
 * and verified against the plan's own implementation: the project's unit
 * environment is happy-dom, whose `Response` constructor drops `Set-Cookie`
 * headers from every input form (verified: `new Response(headers)` loses them,
 * while appending to an existing Headers keeps them). The planned `setCookie`
 * helper built responses via the constructor option and stored nothing, so
 * every replay assertion saw an empty jar. The helper below puts the header on
 * via post-construction `headers.append` — the same object the wrapper reads
 * with `Headers.getSetCookie()` — so each test still asserts exactly the
 * planned behavior.
 *
 * Second deviation, in three cases ("appends", "overwrites", "evicts"): the
 * planned tests read `baseFetch.mock.calls[N]` for a call that is never made —
 * a replay is observable only on the request AFTER the one whose response
 * carried `Set-Cookie`, so the final `fetchFn` request was missing ("appends"
 * needed the same manual `cookie` header on it; for "evicts" the index was one
 * short of the post-eviction call). The missing request lines were added;
 * every assertion is unchanged from the plan.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createCookieJarFetch,
  MAX_COOKIES,
  MAX_COOKIE_BYTES,
} from "@inspector/core/mcp/node/cookieJarFetch.js";

const SERVER = "https://mcp.example/mcp";

function setup() {
  const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
  return { baseFetch, fetchFn: createCookieJarFetch(baseFetch, new URL(SERVER)) };
}

function setCookie(...values: string[]): Response {
  const response = new Response("ok");
  for (const value of values) response.headers.append("set-cookie", value);
  return response;
}

describe("createCookieJarFetch", () => {
  it("stores a Set-Cookie and replays it on the next same-origin request", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("mcp_affinity=pod-a"));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    const second = baseFetch.mock.calls[1];
    expect(new Headers(second?.[1]?.headers).get("cookie")).toBe(
      "mcp_affinity=pod-a",
    );
  });

  it("replays several stored cookies joined with '; ' in storage order", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("b=2", "a=1"));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBe(
      "b=2; a=1",
    );
  });

  it("appends to an existing Cookie header instead of replacing it", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await fetchFn(SERVER, { method: "POST", headers: { cookie: "manual=1" } });
    await fetchFn(SERVER, { method: "POST", headers: { cookie: "manual=1" } });
    const second = baseFetch.mock.calls[1];
    expect(new Headers(second?.[1]?.headers).get("cookie")).toBe(
      "manual=1; affinity=pod-a",
    );
  });

  it("overwrites by name and keeps the original insertion slot", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await fetchFn(SERVER, { method: "POST" });
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-b"));
    await fetchFn(SERVER, { method: "POST" });
    baseFetch.mockResolvedValueOnce(setCookie("other=x"));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[3]?.[1]?.headers).get("cookie")).toBe(
      "affinity=pod-b; other=x",
    );
  });

  it.each([
    ["Max-Age", "affinity=pod-a; Max-Age=0"],
    ["a past Expires", "affinity=pod-a; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
  ])("never replays a cookie expired by %s", async (_label, line) => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie(line));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBeNull();
  });

  it("prefers Max-Age over Expires (RFC 6265 §5.3)", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(
      setCookie("affinity=pod-a; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
    );
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBe(
      "affinity=pod-a",
    );
  });

  it("sends no Cookie header while the jar is empty", async () => {
    const { baseFetch, fetchFn } = setup();
    await fetchFn(SERVER, { method: "POST" });
    const first = baseFetch.mock.calls[0];
    expect(new Headers(first?.[1]?.headers).get("cookie")).toBeNull();
    expect(first?.[1]).toEqual({ method: "POST" });
  });

  it.each([
    ["a token without =", "garbage"],
    ["an empty name", "=value"],
  ])("ignores %s", async (_label, line) => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie(line));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBeNull();
  });

  it("drops a cookie pair over MAX_COOKIE_BYTES", async () => {
    const { baseFetch, fetchFn } = setup();
    const big = `big=${"x".repeat(MAX_COOKIE_BYTES)}`;
    baseFetch.mockResolvedValueOnce(setCookie(big));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBeNull();
  });

  it("evicts the oldest cookie past MAX_COOKIES", async () => {
    const { baseFetch, fetchFn } = setup();
    for (let i = 0; i < MAX_COOKIES; i++) {
      baseFetch.mockResolvedValueOnce(setCookie(`c${i}=v`));
      await fetchFn(SERVER, { method: "POST" });
    }
    baseFetch.mockResolvedValueOnce(setCookie("new=n"));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    const cookie = new Headers(
      baseFetch.mock.calls[MAX_COOKIES + 1]?.[1]?.headers,
    ).get("cookie");
    expect(cookie).toContain("new=n");
    expect(cookie).not.toContain("c0=0");
    expect(cookie).not.toContain("c0=v");
    expect(cookie?.startsWith("c1=v")).toBe(true);
  });

  it("neither stores nor replays across origins", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await fetchFn("https://auth.example.com/token", { method: "POST" });
    await fetchFn(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBeNull();
  });

  it("does not replay a same-origin Set-Cookie onto another origin", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await fetchFn(SERVER, { method: "POST" });
    await fetchFn("https://auth.example.com/token", { method: "POST" });
    const second = baseFetch.mock.calls[1];
    expect(new Headers(second?.[1]?.headers).get("cookie")).toBeNull();
  });

  it("handles a Request input and replays into it", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await fetchFn(new Request(SERVER, { method: "POST", body: "{}" }));
    await fetchFn(new Request(SERVER, { method: "POST", body: "{}" }));
    const second = baseFetch.mock.calls[1];
    expect(new Headers(second?.[1]?.headers).get("cookie")).toBe("affinity=pod-a");
  });

  it("tolerates an unparseable request URL", async () => {
    const { baseFetch, fetchFn } = setup();
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await fetchFn("not a url", { method: "POST" });
    expect((await fetchFn(SERVER, { method: "POST" })).status).toBe(200);
  });

  it("keeps jars independent between connections", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const first = createCookieJarFetch(baseFetch, new URL(SERVER));
    const second = createCookieJarFetch(baseFetch, new URL(SERVER));
    baseFetch.mockResolvedValueOnce(setCookie("affinity=pod-a"));
    await first(SERVER, { method: "POST" });
    await second(SERVER, { method: "POST" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBeNull();
  });
});
