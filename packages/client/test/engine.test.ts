import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { RequestEngine, bigIntegerKeysOption, firstInexactNumber, isBidiControl, parseRetryAfter, sanitizeServerText, scanNumbers } from "../src/engine.js";
import { FdsApiError, FdsError, FdsNetworkError, FdsParseError, FdsValidationError, cutForMessage, cutText, redactUrl, toWellFormed } from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";
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

test("buildUrl rejects a dot segment as a backstop for the id check", () => {
  const e = new RequestEngine({ baseUrl: "https://fragdenstaat.de" });
  assert.throws(() => e.buildUrl("/api/v1/request/./"), {
    name: "FdsError",
    message: 'Invalid path segment "." in /api/v1/request/./: "." and ".." cannot be used as an id.',
  });
  assert.throws(() => e.buildUrl("/api/v1/request/../"), /Invalid path segment "\.\."/);
});

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.lawList));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err: unknown) =>
        err instanceof FdsValidationError &&
        !(err instanceof FdsNetworkError) &&
        /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.lawList));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not-a-url", transport: mt.transport }),
    (err: unknown) => err instanceof FdsValidationError && err.message === 'Invalid baseUrl: Invalid URL "not-a-url".',
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
      name: "FdsValidationError",
      message: "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
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
      name: "FdsValidationError",
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

test("a JSON body is decoded by its declared charset, BOM dropped; an unknown charset is an FdsParseError", async () => {
  const text = "Müller Behörde";
  for (const [charset, body] of [
    ["iso-8859-1", Buffer.from(JSON.stringify({ name: text }), "latin1")],
    ["utf-8", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ name: text }))])],
  ] as const) {
    const engine = new RequestEngine({
      transport: async () => rawResponse(body, `application/json; charset=${charset}`),
    });
    assert.deepEqual(await engine.getJson("/x"), { name: text }, charset);
  }
  const engine = new RequestEngine({ transport: async () => rawResponse("{}", "application/json; charset=x-klingon") });
  await assert.rejects(engine.getJson("/x"), (e: unknown) => e instanceof FdsParseError && /^GET https:\/\/fragdenstaat\.de\/x: unsupported response charset "x-klingon"\.$/.test((e as Error).message));
});

test("server text in an error message is cut at 500 characters; the body keeps it all", async () => {
  const detail = "x".repeat(200_000);
  const engine = new RequestEngine({ transport: async () => jsonResponse({ detail }, 500), maxRetries: 0 });
  await assert.rejects(engine.getJson("/x"), (e: unknown) => {
    assert.ok(e instanceof FdsApiError);
    assert.equal(e.detail, `${"x".repeat(500)}…`);
    assert.ok(e.message.length < 700, String(e.message.length));
    assert.equal(e.body.length, JSON.stringify({ detail }).length);
    return true;
  });
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
  // cutForMessage (500) uses it too.
  assert.equal(toWellFormed(cutForMessage("a" + "\u{1f600}".repeat(400))), cutForMessage("a" + "\u{1f600}".repeat(400)));
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(400), "a" + "\u{1f600}".repeat(400)]) {
    const engine = new RequestEngine({ transport: async () => jsonResponse({ detail }, 500), maxRetries: 0 });
    await assert.rejects(engine.getJson("/x"), (e: unknown) => {
      assert.ok(e instanceof FdsApiError);
      assert.equal(toWellFormed(e.message), e.message);
      assert.match(e.detail ?? "", /…$/);
      return true;
    });
  }
});

test("own messages quote a server or user value at most 500 characters long (L3)", async () => {
  const charset = `x${"y".repeat(10_000)}`;
  const engine = new RequestEngine({ transport: async () => rawResponse("{}", `application/json; charset=${charset}`) });
  await assert.rejects(engine.getJson("/x"), (e: unknown) => e instanceof FdsParseError && e.message.length < 700 && /charset "xy+…"/.test(e.message));
  const id = "i".repeat(10_000);
  assert.throws(() => engine.buildUrl(`/api/v1/request/${id}/..`), (e: unknown) => e instanceof FdsError && e.message.length < 700);
  for (const baseUrl of [`http://[${"a".repeat(10_000)}`, `${"s".repeat(10_000)}://host`]) {
    assert.throws(() => new RequestEngine({ baseUrl }), (e: unknown) => e instanceof FdsValidationError && e.message.length < 700, baseUrl.slice(0, 20));
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the pair UTF-8 encoded (the Authorization header it builds from the URL), so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: makeMockTransport(() => jsonResponse({ detail: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` }, 401)).transport,
  });
  await assert.rejects(engine.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof FdsApiError);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.body.includes(form), err.body);
    return true;
  });
});

// Exploratory test 2026-10-05, result 04 bug 7: an invalid Date threw a raw RangeError.
test("an invalid Date in a filter is an FdsValidationError, not a raw RangeError", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.requestList));
  const engine = new RequestEngine({ transport: mt.transport });
  for (const query of [{ created_at_after: new Date("nope") }, { created_at_after: [new Date(NaN)] }]) {
    await assert.rejects(
      engine.request("GET", "/x", { query, accept: "application/json" }),
      (e: unknown) => e instanceof FdsValidationError && e.message === "Invalid created_at_after: Expected a valid date.",
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("null options are treated like no options", () => {
  new RequestEngine(null as unknown as undefined);
});

// Exploratory test 2026-10-05, result 02 question 1: an unparseable Location kept its userinfo.
test("an unparseable Location is printed with its userinfo redacted", async () => {
  const engine = new RequestEngine({
    transport: async () => ({ status: 302, headers: { location: "http://bob:hunter2@exa mple/" }, body: Buffer.from("") }),
    maxRetries: 0,
  });
  await assert.rejects(engine.getJson("/x"), (e: unknown) => {
    assert.ok(e instanceof FdsApiError);
    assert.ok(!e.message.includes("hunter2"), e.message);
    assert.match(e.message, /redirect to http:\/\/\*\*\*@exa mple\/ not followed/);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://***@example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://***@example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("onRetry is never called without a retry, and a throw in it is swallowed", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({ ok: 1 })).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: Buffer.from('{"detail":"no"}') })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), FdsApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), FdsApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), FdsApiError);
  assert.equal(events.length, 1);
  let n = 0;
  const throwing = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 }))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await throwing.getJson("/x");
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), FdsValidationError);
});

test("a number the answer's JSON cannot carry exactly is a parse error, never a changed value (kit K1)", async () => {
  // JSON.parse turned these into Infinity (printed as null), a rounded integer or 0, with exit 0.
  const body = (n: string) => `{"meta":{"total_count":${n},"limit":50,"offset":0},"objects":[]}`;
  for (const n of [
    "1e400", "-1e400", "12345678901234567890", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: below 2.2250738585072014e-308 a double has fewer digits (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = engine(makeMockTransport(() => rawResponse(body(n), "application/json")).transport);
    await assert.rejects(e.getJson("/api/v1/request/", undefined, "list"), (err) => {
      assert.ok(err instanceof FdsParseError, n);
      assert.equal(err.message, `GET https://fragdenstaat.de/api/v1/request/: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // The same values in other forms, zero in any form, a decimal fraction below 2^53 and
  // numbers inside strings pass.
  const ok: Array<[string, number]> = [
    ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53], ["90071992547409920E-1", 2 ** 53], ["1.2e21", 1.2e21],
    ["0", 0], ["-0", -0], ["0.0e-500", 0], ["0e5", 0], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["1e2", 100],
    ["52.520008", 52.520008],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE],
    ["-1.7976931348623157e308", -Number.MAX_VALUE], ["4.35e30", 4.35e30],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of ok) {
    const e = engine(makeMockTransport(() => rawResponse(body(n), "application/json")).transport);
    assert.equal((await e.getJson<{ meta: { total_count: number } }>("/x/")).meta.total_count, value, n);
  }
  const inString = engine(makeMockTransport(() => rawResponse('{"title":"12345678901234567890 \\" 1e400","n":1}', "application/json")).transport);
  assert.deepEqual(await inString.getJson("/x/"), { title: '12345678901234567890 " 1e400', n: 1 });
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request (kit K3)", async () => {
  // They said only "Request exceeded deadline of 20ms", "Response exceeded the size limit …",
  // "connect ECONNREFUSED 127.0.0.1:9" or "getaddrinfo ENOTFOUND …", so a caller making
  // several calls could not tell which one failed.
  const url = "http://***@127.0.0.1:9/api/v1/law/5/";
  const prefix = `GET ${url} failed: `;
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
  const cases: Array<[string, Partial<ConstructorParameters<typeof RequestEngine>[0]>, RegExp]> = [
    ["engine deadline", { transport: () => new Promise<HttpResponse>(() => {}), timeoutMs: 20 }, /^Request exceeded deadline of 20ms$/],
    ["size cap", { transport: async () => rawResponse("x".repeat(100), "application/json"), maxResponseBytes: 10 }, /^Response exceeded the size limit of 10 bytes/],
    ["transport's own error", { transport: async () => { throw new FdsNetworkError("connect ECONNREFUSED 127.0.0.1:9", { cause: refused }); } }, /^connect ECONNREFUSED 127\.0\.0\.1:9$/],
    ["DNS failure", { transport: async () => { throw new FdsNetworkError("getaddrinfo ENOTFOUND fds.invalid"); } }, /^getaddrinfo ENOTFOUND fds\.invalid$/],
  ];
  for (const [name, options, reason] of cases) {
    const e = new RequestEngine({ baseUrl: "http://u:secret@127.0.0.1:9", maxRetries: 0, sleep: async () => {}, ...options });
    await assert.rejects(e.getJson("/api/v1/law/5/"), (err) => {
      assert.ok(err instanceof FdsNetworkError, name);
      assert.ok(err.message.startsWith(prefix), `${name}: ${err.message}`);
      assert.match(err.message.slice(prefix.length), reason, name);
      assert.ok(!err.message.includes("secret"), name);
      return true;
    });
  }
  // The original stays the cause.
  const e = new RequestEngine({ baseUrl: "http://127.0.0.1:9", maxRetries: 0, transport: async () => { throw new FdsNetworkError("connect ECONNREFUSED 127.0.0.1:9", { cause: refused }); } });
  await assert.rejects(e.getJson("/api/v1/law/"), (err) => {
    assert.ok(err instanceof FdsNetworkError);
    assert.ok(err.cause instanceof FdsNetworkError);
    assert.equal((err.cause as Error).cause, refused);
    return true;
  });
  // A message that names the request already is not prefixed twice.
  const named = new RequestEngine({ baseUrl: "http://127.0.0.1:9", transport: async () => { throw new FdsNetworkError("GET http://127.0.0.1:9/api/v1/law/ failed: x"); } });
  await assert.rejects(named.getJson("/api/v1/law/"), { message: "GET http://127.0.0.1:9/api/v1/law/ failed: x" });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("<html>") }) });
  // With the prototype set, "text/html" was read as the Content-Type and named in the message.
  await assert.rejects(e.getJson("/x"), (err: Error) => err instanceof FdsParseError && !/text\/html/.test(err.message));
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), (err: unknown) => err instanceof FdsParseError && /JSON/.test(err.message));
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof FdsValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none. The client declares none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  assert.equal(new RequestEngine().bigIntegerKeys.size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse, "list" | undefined]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html"), undefined],
    ["empty response body", () => rawResponse(" ", "application/json"), undefined],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json"), undefined],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus"), undefined],
    ["unexpected response shape (HTTP 200)", () => rawResponse("{}", "application/json"), "list"],
  ];
  const base = new URL("https://fragdenstaat.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond, shape] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/api/v1/request/", { q: "x" }, shape), (err: unknown) => {
      assert.ok(err instanceof FdsParseError, what);
      assert.ok(err.message.startsWith("GET https://***@fragdenstaat.de/api/v1/request/?q=x: "), err.message);
      assert.ok(err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // A CSV request answered with an HTML page names it too, and the raw answer carries the request.
  const html = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(() => rawResponse("<html>", "text/html")).transport });
  await assert.rejects(html.getRaw("/api/v1/request/", "text/csv", { format: "csv" }), (err: unknown) =>
    err instanceof FdsParseError && err.message.startsWith("GET https://***@fragdenstaat.de/api/v1/request/?format=csv: unexpected response (HTTP 200): expected text/csv, got an HTML page"));
  const csv = new RequestEngine({ transport: makeMockTransport(() => rawResponse("id\n1\n", "text/csv")).transport });
  assert.equal((await csv.getRaw("/api/v1/request/", "text/csv", { format: "csv" })).request, "GET https://fragdenstaat.de/api/v1/request/?format=csv");
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://fragdenstaat.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), FdsValidationError);
});

test("an answer longer than V8's longest string is an FdsParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"meta":{"total_count":0},"objects":[]}    ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/api/v1/request/", { q: "x" }, "list"), (err: unknown) => {
    assert.ok(err instanceof FdsParseError, String(err));
    assert.equal(
      err.message,
      `GET https://fragdenstaat.de/api/v1/request/?q=x: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof FdsApiError && err.status === 500 && err.body === "");
});

// Exploratory test 2026-10-21, bug 04-1: a reset after spent retries didn't say it was retried.
test("a connection reset after spent retries says so, and the error carries retries, like a status does", async () => {
  const reset = (): never => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  const spent = new RequestEngine({ maxRetries: 2, retryDelayMs: 0, sleep: async () => {}, transport: async () => reset() });
  await assert.rejects(spent.getJson("/api/v1/request/"), (err: unknown) => {
    assert.ok(err instanceof FdsNetworkError, String(err));
    assert.equal(err.message, "GET https://fragdenstaat.de/api/v1/request/ failed: socket hang up (after 2 retries)");
    assert.equal(err.retries, 2);
    return true;
  });
  const once = new RequestEngine({ maxRetries: 1, retryDelayMs: 0, sleep: async () => {}, transport: async () => reset() });
  await assert.rejects(once.getJson("/x/"), (err: unknown) => err instanceof FdsNetworkError && err.message.endsWith("socket hang up (after 1 retry)") && err.retries === 1);
  // No retry: no suffix, retries 0; a failure that is not retried (a refused connection) the same.
  const none = new RequestEngine({ maxRetries: 0, transport: async () => reset() });
  await assert.rejects(none.getJson("/x/"), (err: unknown) => err instanceof FdsNetworkError && err.message.endsWith("failed: socket hang up") && err.retries === 0);
  const refused = new RequestEngine({ maxRetries: 2, transport: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } });
  await assert.rejects(refused.getJson("/x/"), (err: unknown) => err instanceof FdsNetworkError && err.retries === 0 && !/after/.test(err.message));
  // The default transport's own FdsNetworkError (a reset it reports) gets the suffix too.
  const own = new RequestEngine({ maxRetries: 1, retryDelayMs: 0, sleep: async () => {}, transport: async () => { throw new FdsNetworkError("socket hang up", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }); } });
  await assert.rejects(own.getJson("/x/"), (err: unknown) => err instanceof FdsNetworkError && err.message === "GET https://fragdenstaat.de/x/ failed: socket hang up (after 1 retry)" && err.retries === 1);
});
