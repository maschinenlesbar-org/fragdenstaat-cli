import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, isBidiControl, parseRetryAfter, sanitizeServerText } from "../src/client/engine.js";
import { FdsApiError, FdsNetworkError, FdsParseError, redactUrl } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

function engine(transport: ReturnType<typeof makeMockTransport>["transport"], extra = {}) {
  return new RequestEngine({ baseUrl: "https://fragdenstaat.de", transport, sleep: async () => {}, ...extra });
}

test("getJson builds the URL and parses the body", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.requestList));
  const e = engine(mt.transport);
  const result = await e.getJson("/api/v1/request/", { status: "resolved", limit: 1 });
  assert.deepEqual(result, fx.requestList);
  const url = new URL(mt.last().url);
  assert.equal(url.origin + url.pathname, "https://fragdenstaat.de/api/v1/request/");
  assert.equal(url.searchParams.get("status"), "resolved");
  assert.equal(url.searchParams.get("limit"), "1");
});

test("trailing slashes on the base URL are trimmed", () => {
  const e = new RequestEngine({ baseUrl: "https://fragdenstaat.de///" });
  assert.equal(e.buildUrl("/api/v1/law/"), "https://fragdenstaat.de/api/v1/law/");
});

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.lawList));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err: unknown) => err instanceof FdsNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.lawList));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: mt.transport }),
    (err: unknown) => err instanceof FdsNetworkError && /Invalid base URL/.test(err.message),
  );
});

test("sends Accept and User-Agent headers", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.lawList));
  await engine(mt.transport, { userAgent: "ua-x" }).getJson("/api/v1/law/");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["User-Agent"], "ua-x");
});

test("retries a 503 then succeeds, honouring maxRetries", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls < 3 ? jsonResponse({ detail: "busy" }, 503) : jsonResponse(fx.lawList);
  });
  const result = await engine(mt.transport, { maxRetries: 2 }).getJson("/api/v1/law/");
  assert.deepEqual(result, fx.lawList);
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test("gives up after maxRetries and throws FdsApiError", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "busy" }, 429));
  await assert.rejects(
    () => engine(mt.transport, { maxRetries: 1 }).getJson("/api/v1/law/"),
    (err) => err instanceof FdsApiError && err.status === 429 && err.isRetryable,
  );
  assert.equal(mt.calls.length, 2); // 1 initial + 1 retry
});

test("does not retry a non-transient 500", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "boom" }, 500));
  await assert.rejects(() => engine(mt.transport, { maxRetries: 3 }).getJson("/api/v1/law/"));
  assert.equal(mt.calls.length, 1);
});

test("maps a 404 detail body to the error message", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.notFound, 404));
  await assert.rejects(
    () => engine(mt.transport).getJson("/api/v1/request/9/"),
    (err) =>
      err instanceof FdsApiError &&
      err.status === 404 &&
      err.detail === "No FoiRequest matches the given query.",
  );
});

test("maps a 400 field->messages body to the error message", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.validation400, 400));
  await assert.rejects(
    () => engine(mt.transport).getJson("/api/v1/request/"),
    (err) =>
      err instanceof FdsApiError &&
      err.status === 400 &&
      typeof err.detail === "string" &&
      err.detail.startsWith("status: Bitte eine gültige Auswahl"),
  );
});

test("strips control/escape bytes from a hostile error detail", async () => {
  // A hostile/MITM'd endpoint embeds an OSC 52 clipboard-write escape plus a NUL
  // in the error `detail`. JSON.parse turns the backslash-u001b escape into a real
  // ESC byte; toApiError must strip it so nothing drives the terminal via stderr.
  const ESC = String.fromCharCode(0x1b); // never a raw literal in source
  const BEL = String.fromCharCode(0x07);
  const NUL = String.fromCharCode(0x00);
  const detail = "not found " + ESC + "]52;c;ZXZpbA==" + BEL + "rest" + NUL;
  const mt = makeMockTransport(() => jsonResponse({ detail }, 404));
  await assert.rejects(
    () => engine(mt.transport).getJson("/api/v1/request/9/"),
    (err) => {
      assert.ok(err instanceof FdsApiError);
      assert.ok(typeof err.detail === "string");
      assert.ok(!err.detail.includes(ESC));
      assert.ok(!err.detail.includes(BEL));
      assert.ok(!err.detail.includes(NUL));
      // The visible text survives.
      assert.match(err.detail, /not found/);
      assert.match(err.detail, /rest/);
      return true;
    },
  );
});

test("getRaw returns bytes and the content-type", async () => {
  const mt = makeMockTransport(() => rawResponse(fx.csvBody, "text/csv; charset=utf-8"));
  const res = await engine(mt.transport).getRaw("/api/v1/request/", "text/csv", { format: "csv" });
  assert.equal(res.contentType, "text/csv; charset=utf-8");
  assert.equal(res.data.toString("utf8"), fx.csvBody);
  assert.equal(new URL(mt.last().url).searchParams.get("format"), "csv");
  assert.equal(mt.last().headers?.["Accept"], "text/csv");
});

test("throws FdsParseError on a non-JSON 2xx body", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>not json</html>", "text/html"));
  await assert.rejects(
    () => engine(mt.transport).getJson("/api/v1/request/"),
    (err) => err instanceof FdsParseError,
  );
});

// Exploratory test 2026-09-26, finding 7: LF/TAB and bidi in server text.
test("error detail is one line without bidi controls", async () => {
  const detail = "Not found\nFAKE: line\t x ‮evil⁦";
  const mt = makeMockTransport(() => jsonResponse({ detail }, 404));
  await assert.rejects(
    () => engine(mt.transport).getJson("/api/v1/request/9/"),
    (err) => {
      assert.ok(err instanceof FdsApiError);
      assert.equal(err.detail, "Not found FAKE: line x evil");
      assert.equal(err.message.split("\n").length, 1);
      return true;
    },
  );
});

test("sanitizeServerText keeps printable text and folds whitespace", () => {
  assert.equal(sanitizeServerText("  a\r\n\tb\u0085c‏d  "), "a bcd");
  assert.equal(isBidiControl(0x202e), true);
  assert.equal(isBidiControl(0x0041), false);
});

// Exploratory test 2026-09-26, finding 8: Retry-After and the retry bound.
function retryEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    body: Buffer.from('{"detail":"slow down"}'),
  }));
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { e, mt, delays };
}

test("a 429 with Retry-After waits the server's delay", async () => {
  const { e, mt, delays } = retryEngine("1");
  await assert.rejects(e.getJson("/api/v1/request/"), FdsApiError);
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(mt.calls.length, 3);
});

test("a malformed Retry-After falls back to linear backoff", async () => {
  for (const bad of ["-1", "1.5", "1e3", "0x10", "Wed, 21 Oct 2026 07:28:00 +0000", ""]) {
    const { e, delays } = retryEngine(bad);
    await assert.rejects(e.getJson("/api/v1/request/"), FdsApiError);
    assert.deepEqual(delays, [200, 400], bad);
  }
});

test("a Retry-After beyond 30 s is not retried at all", async () => {
  for (const long of ["31", "99999999999", "Fri, 01 Jan 2100 00:00:00 GMT"]) {
    const { e, mt, delays } = retryEngine(long);
    await assert.rejects(e.getJson("/api/v1/request/"), /HTTP 429 .*: slow down/);
    assert.equal(mt.calls.length, 1, long);
    assert.deepEqual(delays, []);
  }
});

test("parseRetryAfter reads seconds and IMF-fixdates only", () => {
  const now = Date.parse("Sat, 26 Sep 2026 12:00:00 GMT");
  assert.equal(parseRetryAfter("3", now), 3000);
  assert.equal(parseRetryAfter([" 2 "], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 12:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 11:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("Saturday, 26-Sep-26 12:00:05 GMT", now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://h.example/?x=1", "https://h.example/#f"]) {
    assert.throws(() => new RequestEngine({ baseUrl }), {
      name: "FdsNetworkError",
      message: `Base URL must not contain a query or fragment: ${baseUrl}`,
    });
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("https://u:p@h.example/x?q=1"), "https://***@h.example/x?q=1");
  assert.equal(redactUrl("https://h.example/x"), "https://h.example/x");
  assert.equal(redactUrl("not a url"), "not a url");
  assert.throws(() => new RequestEngine({ baseUrl: "https://u:pw@h.example/?x=1" }), (err: Error) => {
    assert.doesNotMatch(err.message, /pw/);
    return true;
  });
});

// Exploratory test 2026-09-26, finding 15: invalid EngineOptions.
test("invalid numeric engine options throw instead of disabling limits", () => {
  const bad: Array<[string, number]> = [
    ["timeoutMs", NaN],
    ["timeoutMs", -5],
    ["timeoutMs", 2 ** 31],
    ["maxResponseBytes", -1],
    ["maxResponseBytes", 1.5],
    ["maxRetries", Infinity],
    ["maxRetries", 11],
    ["retryDelayMs", -100],
  ];
  for (const [name, value] of bad) {
    assert.throws(() => new RequestEngine({ [name]: value }), {
      name: "FdsError",
      message: new RegExp(`^Invalid option ${name}: expected an integer from 0 to \\d+, got ${String(value)}\\.$`),
    });
  }
  // Boundaries and 0 are fine.
  new RequestEngine({ timeoutMs: 0, maxResponseBytes: 0, maxRetries: 10, retryDelayMs: 30_000 });
});

// Exploratory test 2026-09-26, finding 19: a 3xx names its Location.
test("a 3xx error names the redirect target it did not follow", async () => {
  const redirect = (location?: string) =>
    makeMockTransport(() => ({
      status: 301,
      headers: location === undefined ? {} : { location },
      body: Buffer.from(""),
    }));
  const http = new RequestEngine({ baseUrl: "http://fragdenstaat.de", transport: redirect("https://fragdenstaat.de/api/v1/law/?limit=1").transport });
  await assert.rejects(http.getJson("/api/v1/law/", { limit: 1 }), {
    message:
      "HTTP 301 for GET http://fragdenstaat.de/api/v1/law/?limit=1: redirect to https://fragdenstaat.de/api/v1/law/?limit=1 not followed",
  });
  const rel = engine(redirect("/x\n\u001b[2Jy").transport);
  await assert.rejects(rel.getJson("/api/v1/law"), (err) => {
    assert.ok(err instanceof FdsApiError);
    assert.equal(err.location, "https://fragdenstaat.de/x%1B[2Jy");
    return true;
  });
  const cred = engine(redirect("http://u:pw@evil.example/x").transport);
  await assert.rejects(cred.getJson("/api/v1/law/"), /redirect to http:\/\/\*\*\*@evil\.example\/x not followed$/);
  const none = engine(redirect().transport);
  await assert.rejects(none.getJson("/api/v1/law/"), /: redirect not followed \(no Location header\)$/);
});
