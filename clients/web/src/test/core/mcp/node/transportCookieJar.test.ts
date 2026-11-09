/**
 * The `cookieJar` setting wires `createCookieJarFetch` into both HTTP
 * transports: a `Set-Cookie` on any response of the connection is replayed as
 * `Cookie` on every later request to the server's origin, which is what pins
 * a cookie-affinity load balancer to the replica holding the MCP session.
 * Off by default, so the control arm pins that nothing changes for a server
 * that never asked for the jar.
 *
 * One deliberate deviation from the planned verbatim file, mirroring
 * `cookieJarFetch.test.ts`: the unit environment is happy-dom, whose
 * `Response` constructor drops `set-cookie` from every input form, so the
 * helpers append the header post-construction — otherwise the jar would store
 * nothing and every replay assertion would see an empty jar.
 */
import { describe, it, expect, vi } from "vitest";
import { createTransportNode } from "@inspector/core/mcp/node/transport.js";
import type {
  MCPServerConfig,
  InspectorServerSettings,
} from "@inspector/core/mcp/types.js";

function settings(cookieJar: boolean): InspectorServerSettings {
  return {
    headers: [],
    metadata: {},
    env: [],
    connectionTimeout: 0,
    requestTimeout: 0,
    taskTtl: 0,
    maxFetchRequests: 1000,
    roots: [],
    ...(cookieJar && { cookieJar: true }),
  };
}

function json(setCookie?: string): Response {
  const response = new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

function sseStream(setCookie?: string): Response {
  const response = new Response("event: endpoint\ndata: /messages\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

/** Start a transport, drive two requests, return the Cookie header of each call. */
async function sentCookies(
  config: MCPServerConfig,
  withJar: boolean,
): Promise<(string | null)[]> {
  let postCount = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return sseStream("affinity=pod-a");
    postCount += 1;
    return json(postCount === 1 ? "affinity=pod-a" : undefined);
  });
  const { transport } = createTransportNode(config, {
    fetchFn,
    settings: settings(withJar),
  });
  await transport.start();
  await transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await transport.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await transport.close();
  return fetchFn.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("cookie"),
  );
}

const TRANSPORTS: {
  name: string;
  config: MCPServerConfig;
  expectedWithJar: (string | null)[];
}[] = [
  {
    name: "streamable-http",
    config: { type: "streamable-http", url: "https://mcp.example/mcp" },
    // initialize POST stores the cookie; ping POST replays it.
    expectedWithJar: [null, "affinity=pod-a"],
  },
  {
    name: "sse",
    config: { type: "sse", url: "https://mcp.example/sse" },
    // Three calls in order — the GET stream, the initialize POST, the ping
    // POST. The jar is empty on the GET (no cookie to replay yet) and the
    // GET's Set-Cookie is stored, so both POSTs replay it.
    expectedWithJar: [null, "affinity=pod-a", "affinity=pod-a"],
  },
];

describe.each(TRANSPORTS)(
  "cookieJar setting ($name)",
  ({ config, expectedWithJar }) => {
    it("replays Set-Cookie on later requests when on", async () => {
      expect(await sentCookies(config, true)).toEqual(expectedWithJar);
    });

    it("sends no Cookie header when off (default)", async () => {
      expect((await sentCookies(config, false)).every((c) => c === null)).toBe(
        true,
      );
    });
  },
);
