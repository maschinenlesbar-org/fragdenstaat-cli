import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { nodeHttpTransport } from "../src/client/http.js";
import { FdsNetworkError } from "../src/client/errors.js";

async function withServer(
  handler: http.RequestListener,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("returns status, headers and body for a normal response", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    },
    async (base) => {
      const res = await nodeHttpTransport({ method: "GET", url: `${base}/api/v1/request/?limit=1` });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
        ok: true,
        path: "/api/v1/request/?limit=1",
      });
    },
  );
});

test("resolves (does not reject) on a non-2xx status", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "nope" }));
    },
    async (base) => {
      const res = await nodeHttpTransport({ method: "GET", url: `${base}/x/` });
      assert.equal(res.status, 404);
    },
  );
});

test("forwards request headers", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(req.headers["user-agent"] ?? "");
    },
    async (base) => {
      const res = await nodeHttpTransport({
        method: "GET",
        url: `${base}/`,
        headers: { "User-Agent": "fragdenstaat-cli-test" },
      });
      assert.equal(res.body.toString("utf8"), "fragdenstaat-cli-test");
    },
  );
});

test("rejects an unsupported protocol with a typed error", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.com/x" }),
    (err) => err instanceof FdsNetworkError && /Unsupported protocol/.test(err.message),
  );
});

test("rejects a malformed URL with a typed error", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "not a url" }),
    (err) => err instanceof FdsNetworkError && /Invalid URL/.test(err.message),
  );
});

test("aborts and rejects when the response exceeds maxResponseBytes", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(1024, 0x61)); // 1 KiB of 'a'
    },
    async (base) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: `${base}/`, maxResponseBytes: 100 }),
        (err) => err instanceof FdsNetworkError && /maxResponseBytes/.test(err.message),
      );
    },
  );
});

test("times out slow responses", async () => {
  await withServer(
    (_req, res) => {
      // Never respond within the window.
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 1000).unref();
    },
    async (base) => {
      await assert.rejects(
        // A server that never responds trips either the idle timeout or the
        // wall-clock deadline (both armed at the same duration); either is a
        // correct timeout outcome.
        () => nodeHttpTransport({ method: "GET", url: `${base}/`, timeoutMs: 50 }),
        (err) => err instanceof FdsNetworkError && /(timed out|deadline)/.test(err.message),
      );
    },
  );
});

test("a slow-drip response is bounded by the wall-clock deadline", async () => {
  // The server dribbles one byte at a time and never ends. Each byte resets the
  // idle-socket timeout, so without a separate wall-clock deadline the request
  // would hang forever while staying under maxResponseBytes. The deadline must
  // still fire and surface a FdsNetworkError.
  const timers: NodeJS.Timeout[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write("x"), 20);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    },
    async (base) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: `${base}/`, timeoutMs: 80 }),
        (err: unknown) => {
          assert.ok(err instanceof FdsNetworkError);
          // The wall-clock deadline, not the idle timeout, is what caught it.
          assert.match(err.message, /deadline/);
          return true;
        },
      );
    },
  );
  for (const t of timers) clearInterval(t);
});
