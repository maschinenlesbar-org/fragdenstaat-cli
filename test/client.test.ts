import { test } from "node:test";
import assert from "node:assert/strict";
import { FragDenStaatClient } from "../src/client/client.js";
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

test("requests.get URL-encodes the id", async () => {
  const { client: c, mt } = client(() => jsonResponse(fx.requestDetail));
  await c.requests.get("a b/c");
  assert.equal(new URL(mt.last().url).pathname, "/api/v1/request/a%20b%2Fc/");
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
