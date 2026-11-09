/**
 * End-to-end proof for the cookieJar setting against a load balancer that
 * routes by cookie affinity — the deployment shape that motivated it. Two
 * single-pod "replicas" accept session-bound requests only when the request
 * carries their own affinity cookie; an in-process round-robin proxy assigns
 * pods via `Set-Cookie: lb_affinity=…` exactly like an nginx sticky ingress.
 * Without the jar the Inspector drops that cookie and its `tools/list`
 * round-robins into "Session not found"; with it, the whole session pins to
 * one pod.
 *
 * Adaptations from the task-brief skeleton (required by the real SDK's
 * request sequence, SDK 2.4.0, mode "legacy"):
 *
 * 1. The proxy forwards the client's `Cookie` header verbatim instead of
 *    injecting the assigned pod's cookie into the upstream request. Injecting
 *    it makes every replica see its own cookie, so the replicas' 404 branch
 *    is unreachable and the control arm could never fail; verbatim
 *    forwarding is also what a real sticky reverse proxy does — the backend
 *    receives the client's original cookies and the balancer stamps
 *    `Set-Cookie` on the response only.
 * 2. The replica exempts two request classes from the affinity check:
 *    - `initialize`: affinity is being learned on this very exchange — a real
 *      balancer stamps `Set-Cookie` on the initialize response, so the pod
 *      must serve it before any cookie exists.
 *    - id-less JSON-RPC messages (notifications): the SDK awaits
 *      `notifications/initialized` inside `connect()` and a failed POST there
 *      closes the connection — a control arm would then die before ever
 *      reaching `listTools()`. Serving them regardless keeps the brief's
 *      shape (connect succeeds in both arms) with the failure signal on the
 *      session-bound `tools/list`, and matches balancers whose backends
 *      tolerate session-less notifications.
 * 3. The replica parses the body defensively (empty/non-JSON bodies — e.g. a
 *    session DELETE on teardown — are answered without affinity checks).
 * 4. afterEach also severs the servers' pooled keep-alive sockets
 *    (`closeIdleConnections`/`closeAllConnections`), since the SDK's undici
 *    dispatcher keeps them open past `disconnect()` and a plain `close()`
 *    would wait out the ~4s keep-alive timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { InspectorClient } from "@inspector/core/mcp/inspectorClient.js";
import { createTransportNode } from "@inspector/core/mcp/node/transport.js";
import type { InspectorServerSettings } from "@inspector/core/mcp/types.js";

const COOKIE = "lb_affinity";

/**
 * One replica. Serves `initialize` and id-less notifications to anyone;
 * every other JSON-RPC request (an id, session-bound) must carry this pod's
 * own affinity cookie or it is answered `404 Session not found` — the pod
 * does not hold a session it was not pinned. GET is answered 405 (no
 * standalone stream: the SDK treats that as "POST-only server").
 */
function startReplica(pod: string): Promise<Server> {
  const server = createServer((req, res) => {
    const cookies = String(req.headers.cookie ?? "");
    const mine = cookies
      .split(";")
      .some((c) => c.trim() === `${COOKIE}=${pod}`);
    if ((req.method ?? "").toUpperCase() === "GET") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      let message:
        | {
            id?: number | string;
            method?: string;
            params?: { protocolVersion?: string };
          }
        | undefined;
      try {
        if (body !== "") message = JSON.parse(body);
      } catch {
        // Non-JSON body (e.g. a session DELETE): nothing session-bound here.
      }
      if (message?.id === undefined) {
        // Notification or non-JSON POST: no session-bound work, no affinity.
        res.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        // First contact: affinity is learned on this response.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: {},
              serverInfo: { name: `replica-${pod}`, version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (!mine) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      let result: Record<string, unknown> = {};
      if (message.method === "tools/list") {
        result = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Round-robin affinity proxy: forwards the client's cookies verbatim; when a
 * request arrives with none, the next replica is assigned and the response
 * carries `Set-Cookie: lb_affinity=<pod>`, exactly like a sticky ingress.
 * Every later request that replays the cookie sticks to its pod.
 */
function startAffinityProxy(
  replicas: { server: Server; pod: string }[],
): Promise<Server> {
  let next = 0;
  const server = createServer((req, res) => {
    const cookies = String(req.headers.cookie ?? "");
    const match = cookies.match(new RegExp(`${COOKIE}=([^;]+)`));
    const assigned =
      match?.[1] ?? `pod-${String.fromCharCode(97 + (next++ % replicas.length))}`;
    const target =
      replicas.find((r) => r.pod === assigned)?.server ?? replicas[0].server;
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      const port = (target.address() as { port: number }).port;
      const headers: Record<string, string> = {};
      if (cookies !== "") headers.cookie = cookies;
      fetch(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" ? undefined : body,
      })
        .then(async (up) => {
          const outHeaders: Record<string, string> = {
            "content-type": up.headers.get("content-type") ?? "application/json",
          };
          if (!match) outHeaders["set-cookie"] = `${COOKIE}=${assigned}`;
          res.writeHead(up.status, outHeaders);
          res.end(Buffer.from(await up.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(502).end();
        });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Sever pooled keep-alive sockets, then close. */
function stopServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("cookieJar behind an affinity load balancer", () => {
  let client: InspectorClient | null = null;
  let proxy: Server | null = null;
  const replicas: { server: Server; pod: string }[] = [];

  afterEach(async () => {
    await client?.disconnect().catch(() => {});
    client = null;
    const toClose = [
      ...(proxy ? [stopServer(proxy)] : []),
      ...replicas.map((r) => stopServer(r.server)),
    ];
    proxy = null;
    replicas.length = 0;
    await Promise.allSettled(toClose);
  });

  function settings(cookieJar: boolean): InspectorServerSettings {
    return {
      headers: [],
      metadata: {},
      env: [],
      connectionTimeout: 0,
      requestTimeout: 0,
      taskTtl: 60000,
      maxFetchRequests: 1000,
      roots: [],
      cookieJar: cookieJar || undefined,
      // Both arms run POST-only: the replicas answer the standalone GET with
      // 405, so the failure signal in the control arm stays the 404 affinity
      // miss rather than any stream semantics.
      suppressNotificationStream: true,
    };
  }

  async function connect(cookieJar: boolean): Promise<InspectorClient> {
    replicas.push({ server: await startReplica("pod-a"), pod: "pod-a" });
    replicas.push({ server: await startReplica("pod-b"), pod: "pod-b" });
    proxy = await startAffinityProxy(replicas);
    const port = (proxy.address() as { port: number }).port;
    client = new InspectorClient(
      { type: "streamable-http", url: `http://127.0.0.1:${port}/mcp` },
      {
        environment: { transport: createTransportNode },
        serverSettings: settings(cookieJar),
      },
    );
    await client.connect();
    return client;
  }

  it("fails without the jar: requests round-robin into Session not found", async () => {
    const connected = await connect(false);
    await expect(connected.listTools()).rejects.toThrow(
      /Session not found|404|405/i,
    );
  });

  it("pins the session with the jar: tools list succeeds", async () => {
    const connected = await connect(true);
    const tools = await connected.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["ping"]);
  });
});
