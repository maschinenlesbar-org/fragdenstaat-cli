import { test } from "node:test";
import assert from "node:assert/strict";
import { FragDenStaatClient } from "../src/client/client.js";
import { FdsParseError, FdsValidationError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

function client(responder: () => ReturnType<typeof jsonResponse>) {
  const mt = makeMockTransport(responder);
  return { client: new FragDenStaatClient({ transport: mt.transport }), mt };
}

test("requests.list hits /api/v1/request/ with filters", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestList));
  await c.requests.list({ status: "resolved", jurisdiction: 1, limit: 5 });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/api/v1/request/");
  assert.equal(url.searchParams.get("status"), "resolved");
  assert.equal(url.searchParams.get("jurisdiction"), "1");
  assert.equal(url.searchParams.get("limit"), "5");
});

test("requests.get hits the detail path with a trailing slash", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestDetail));
  await c.requests.get(374948);
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/request/374948/");
});

test("requests.get takes a digit-only string id as well", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestDetail));
  await c.requests.get("374948");
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/request/374948/");
});

test("requests.search hits /request/search/", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestList));
  await c.requests.search({ q: "umwelt" });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/api/v1/request/search/");
  assert.equal(url.searchParams.get("q"), "umwelt");
});

test("requests.listCsv requests CSV via format param and Accept header", async () => {
  const { client: c, mt } = client(() => rawResponse(fx.csvBody, "text/csv"));
  await c.requests.listCsv({ status: "resolved" });
  const req = mt.last();
  assert.equal(new URL(req.url).searchParams.get("format"), "csv");
  assert.equal(new URL(req.url).searchParams.get("status"), "resolved");
  assert.equal(req.headers?.["Accept"], "text/csv");
});

test("requests.tagsAutocomplete hits the tag autocomplete path", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.tagsAutocomplete));
  await c.requests.tagsAutocomplete("lob");
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/api/v1/request/tags/autocomplete/");
  assert.equal(url.searchParams.get("q"), "lob");
});

test("publicBodies.autocomplete hits /publicbody/autocomplete/", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.autocomplete));
  const res = await c.publicBodies.autocomplete("umwelt");
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/publicbody/autocomplete/");
  assert.deepEqual(res, fx.autocomplete);
});

test("publicBodies.search hits /publicbody/search/", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.publicBodyList));
  await c.publicBodies.search({ q: "umwelt" });
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/publicbody/search/");
});

test("publicBodies.searchCsv negotiates CSV on the search path", async () => {
  const mt = makeMockTransport(() => rawResponse(fx.csvBody, "text/csv"));
  const c = new FragDenStaatClient({ transport: mt.transport });
  await c.publicBodies.searchCsv({ q: "umwelt" });
  const req = mt.last();
  assert.equal(new URL(req.url).pathname, "/api/v1/publicbody/search/");
  assert.equal(new URL(req.url).searchParams.get("format"), "csv");
  assert.equal(req.headers?.["Accept"], "text/csv");
});

test("laws.autocomplete hits /law/autocomplete/", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.autocomplete));
  await c.laws.autocomplete("ifg");
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/law/autocomplete/");
});

test("simple resources hit their list paths", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.jurisdictionList));
  await c.jurisdictions.list();
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/jurisdiction/");
  await c.classifications.list();
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/classification/");
  await c.campaigns.list();
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/campaign/");
  await c.categories.list();
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/category/");
  await c.messages.list({ request: 1 });
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/message/");
  await c.documents.list();
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/document/");
  await c.georegions.list();
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/georegion/");
});

test("the client rejects a non-http(s) base URL before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.lawList));
    assert.throws(
      () => new FragDenStaatClient({ baseUrl, transport: mt.transport }),
      FdsValidationError,
    );
    assert.equal(mt.calls.length, 0);
  }
});

// Exploratory test 2026-09-26, finding 3: "." / ".." ids are dot segments.
// Parity report finding 1: every wrapped detail endpoint takes an integer id.
test("get() rejects a non-numeric id before any request", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestList));
  await assert.rejects(c.requests.get("."), {
    name: "FdsValidationError",
    message: "Invalid id: Expected a numeric id (digits only).",
  });
  await assert.rejects(c.publicBodies.get(".."), { name: "FdsValidationError" });
  for (const id of ["search", "autocomplete", " 1", "1 ", "1.0", "1.5", "-1", "1?x=1", "a b/c", "0x10"]) {
    await assert.rejects(c.laws.get(id), { name: "FdsValidationError" }, JSON.stringify(id));
  }
  for (const id of [1.5, -1, NaN, Infinity, 2 ** 53]) {
    await assert.rejects(c.laws.get(id), { name: "FdsValidationError" }, String(id));
  }
  await assert.rejects(c.jurisdictions.get(""), {
    name: "FdsValidationError",
    message: "Invalid id: Expected a non-empty value.",
  });
  assert.equal(mt.calls.length, 0);
  await c.laws.get(0);
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/law/0/");
});


// Parity report finding 2: publicBodies.search inherits lnglat (no CLI flag).
test("publicBodies.search/searchCsv check lnglat before any request", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestList));
  await assert.rejects(c.publicBodies.search({ lnglat: "Berlin" }), { name: "FdsValidationError" });
  await assert.rejects(c.publicBodies.searchCsv({ lnglat: "51.34,120" }), { name: "FdsValidationError" });
  assert.equal(mt.calls.length, 0);
  await c.publicBodies.search({ lnglat: "12.37,51.34" });
  assert.equal(new URL(mt.last().url).searchParams.get("lnglat"), "12.37,51.34");
});

// Exploratory test 2026-10-05, result 03 bug 3: a 200 with the wrong shape exited 0.
test("a 2xx body without the documented shape is an FdsParseError", async () => {
  for (const body of [null, {}, [1, 2], "text", { detail: "Wartung" }, { objects: [] }, { meta: {}, objects: [] }, { meta: { total_count: 1 }, objects: null }]) {
    const { client: c } = client(() => jsonResponse(body));
    await assert.rejects(c.requests.list(), FdsParseError, `list ${JSON.stringify(body)}`);
    await assert.rejects(c.requests.search({ q: "x" }), FdsParseError, `search ${JSON.stringify(body)}`);
    await assert.rejects(c.laws.autocomplete("x"), FdsParseError, `autocomplete ${JSON.stringify(body)}`);
  }
  for (const body of [null, {}, [1, 2], "text", 5]) {
    const { client: c } = client(() => jsonResponse(body));
    await assert.rejects(c.requests.get(5), FdsParseError, `get ${JSON.stringify(body)}`);
  }
  const { client: ok } = client(() => jsonResponse(fx.requestList));
  await ok.requests.list();
});

test("a CSV request answered with an HTML page or JSON is an FdsParseError", async () => {
  for (const [body, type] of [
    ["<html>Wartung</html>", "text/html"],
    ["<!DOCTYPE html><p>Wartung</p>", "text/plain"],
    ['{"meta":{"total_count":0},"objects":[]}', "application/json"],
  ] as const) {
    const { client: c } = client(() => rawResponse(body, type));
    await assert.rejects(c.requests.listCsv(), (e: unknown) => e instanceof FdsParseError && /expected text\/csv/.test((e as Error).message), type);
  }
  const { client: ok } = client(() => rawResponse("id,title\n1,a\n", "text/csv; charset=utf-8"));
  assert.equal((await ok.requests.listCsv()).data.toString("utf8"), "id,title\n1,a\n");
});

// Exploratory test 2026-10-05, result 04 bug 7: autocomplete(undefined) sent no q.
test("autocomplete without a usable q rejects before any request", async () => {
  for (const q of [undefined, null, "", "  ", 5, ["a"]]) {
    const { client: c, mt } = client(() => jsonResponse(fx.autocomplete));
    for (const call of [
      () => c.laws.autocomplete(q as unknown as string),
      () => c.publicBodies.autocomplete(q as unknown as string),
      () => c.requests.tagsAutocomplete(q as unknown as string),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof FdsValidationError && e.message === "Invalid q: Expected a non-empty value.", String(q));
    }
    assert.equal(mt.calls.length, 0);
  }
});
