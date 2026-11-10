import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { nodeHttpTransport } from "../src/http.js";
import { FdsNetworkError } from "../src/errors.js";

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

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (base) => {
        const resp = await nodeHttpTransport({ method: "GET", url: `${base}/`, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
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

// Parity report finding 6: Node rejects a bad header value synchronously inside
// driver.request(); that must surface as an FdsNetworkError, not a raw TypeError.
test("a header value Node rejects becomes an FdsNetworkError", async () => {
  await assert.rejects(
    nodeHttpTransport({
      method: "GET",
      url: "http://127.0.0.1:9/",
      headers: { "User-Agent": "a\r\nX-Evil: 1" },
    }),
    (err: unknown) => err instanceof FdsNetworkError && /Invalid request/.test(err.message),
  );
});

/** Answer every connection with `answer` (a whole HTTP response, as bytes) and run `fn` against it. */
async function withRawServer(answer: Buffer, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a body in many tiny chunks arrives whole and in order, and the byte cap still holds", async () => {
  // 300 001 chunks of 1 to 3 bytes: whatever the transport joins on the way, every byte is kept
  // once, in order (the memory side is conformance test P27, the bin in a small heap).
  const pieces = Array.from({ length: 300_001 }, (_, i) => "abc".slice(0, (i % 3) + 1));
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  const wire = Buffer.from(head + pieces.map((p) => `${p.length}\r\n${p}\r\n`).join("") + "0\r\n\r\n", "latin1");
  const expected = pieces.join("");
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, expected.length);
    assert.ok(res.body.equals(Buffer.from(expected, "latin1")));
  });
  await withRawServer(wire, async (baseUrl) => {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length - 1 }),
      (err: unknown) => err instanceof FdsNetworkError && /exceeded the size limit/.test(err.message),
    );
  });
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length });
    assert.equal(res.body.length, expected.length);
  });
});

test("a URL typed without its scheme is refused without its user name, token or password (F5 class)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  // A mistyped scheme (`http//`, the colon left out; `htp:/`) left the userinfo unfound too.
  for (const url of [
    "my_user:s3cret-pw@h.example/x",
    "T0kenS3cret:@h.example/x",
    "alice:s3cret-pw@h.example/x",
    "http//alice:s3cret-pw@h.example/x",
    "http/alice:s3cret-pw@h.example/x",
    "htp:/alice:s3cret-pw@h.example/x",
  ]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof FdsNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /\*\*\*@h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof FdsNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://***@h.example/x', String(ftp));
});
