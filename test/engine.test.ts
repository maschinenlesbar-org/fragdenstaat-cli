import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { FdsApiError, FdsParseError } from "../src/client/errors.js";
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
