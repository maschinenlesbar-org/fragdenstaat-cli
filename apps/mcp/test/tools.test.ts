// This server's tools against a mock of the FragDenStaat API (the client's live answers of
// 2026-11-19), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema), names are resolved to what
// the endpoint takes, a name fitting several is ambiguous, the full-text search refuses a status,
// outcomes count resolved requests only, documents take a tag slug, a jurisdiction's laws come
// with deadlines in words, and every result names its requests and the data's terms. The rules
// every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { CAMPAIGNS, fdsApi, variant } from "./helpers.js";
import type { JsonObject } from "@maschinenlesbar.org/fragdenstaat-client";

const API = "https://fragdenstaat.de";

test("eight tools: the five use cases, then one request, one document and the reference lists", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findPublicBody", "findRequests", "getRequestOutcomes", "findDocuments", "findLaws", "getRequest", "getDocument", "searchReference"]);
});

test("findPublicBody: a name is the profile with the FOI email; the source names both requests; the terms", async () => {
  const transport = fdsApi();
  const connection = await connect({ transport });
  const result = await connection.call("findPublicBody", { name: "Umweltbundesamt" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal((content["body"] as { email: string }).email, "buergerservice@uba.de");
  assert.equal(content["source"], `${API}/{api/v1/publicbody/autocomplete/?limit=50&q=Umweltbundesamt,api/v1/publicbody/875/}`);
  assert.match(String(content["licence"]), /^Quelle: FragDenStaat\.de .*CC0 1\.0.*§ 5 UrhG.*GDPR.*DATA_LICENSE\.md$/);
  const several = (await connection.call("findPublicBody", { name: "Ministerium" })).structuredContent ?? {};
  assert.equal(several["status"], "ambiguous");
  assert.equal((several["ambiguous"] as { total: number }).total, 4);
  await connection.close();
});

test("findPublicBody: bodies by type and place page; one request's source is that request", async () => {
  const transport = fdsApi();
  const connection = await connect({ transport });
  const content = (await connection.call("findPublicBody", { classification: "Ministerium", jurisdiction: "7", limit: 2 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal((content["bodies"] as unknown[]).length, 2);
  assert.equal(content["nextOffset"], 2);
  assert.equal(content["total"], 5);
  assert.equal(transport.last().url, `${API}/api/v1/publicbody/?jurisdiction=7&classification=118&offset=0&limit=2`);
  const point = await connection.call("findPublicBody", { point: "Marienplatz" });
  assert.equal(point.isError, true, "the schema's lng,lat pattern");
  await connection.close();
});

test("findRequests: full text with a status is a tool error naming the list; a tag is looked up and the list filtered", async () => {
  const transport = fdsApi();
  const connection = await connect({ transport });
  const refused = await connection.call("findRequests", { query: "Kameras", status: "resolved" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /takes only jurisdiction and category/);
  assert.equal(transport.calls.length, 0);
  const content = (await connection.call("findRequests", { tag: "Videoüberwachung", status: "resolved", limit: 2 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["total"], 5);
  assert.equal(content["nextOffset"], 2);
  assert.equal(content["source"], `${API}/{api/v1/request/tags/autocomplete/?limit=50&q=Video%C3%BCberwachung,api/v1/request/?status=resolved&tags=Video%C3%BCberwachung&offset=0&limit=2}`);
  await connection.close();
});

test("getRequestOutcomes: the rate over the resolved requests, with the verdict", async () => {
  const connection = await connect({ transport: fdsApi() });
  const content = (await connection.call("getRequestOutcomes", { tag: "Videoüberwachung" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["successRate"], 80);
  assert.match(String(content["verdict"]), /^5 of 5 requests resolved/);
  assert.equal(String(content["source"]).split(",").length, 9);
  await connection.close();
});

test("findDocuments: a number as tag is refused before any request; an authority by name", async () => {
  const transport = fdsApi();
  const connection = await connect({ transport });
  assert.equal((await connection.call("findDocuments", { tag: "1" })).isError, true);
  assert.equal((await connection.call("findDocuments", {})).isError, true);
  assert.equal(transport.calls.length, 0);
  const content = (await connection.call("findDocuments", { publicBody: "Umweltbundesamt" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["total"], 3);
  await connection.close();
});

test("findLaws: a Land's laws with the deadline in words and the local-statute note; one law in full", async () => {
  const connection = await connect({ transport: fdsApi() });
  const content = (await connection.call("findLaws", { jurisdiction: "Bayern" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const laws = content["laws"] as { id: number; deadline: { text: string } }[];
  assert.equal(laws.find((l) => l.id === 166)?.deadline.text, "5 working days");
  assert.match(JSON.stringify(content["notes"]), /Local statutes/);
  const one = (await connection.call("findLaws", { law: "2" })).structuredContent ?? {};
  assert.deepEqual((one["law"] as { combined: { id: number }[] }).combined.map((c) => c.id), [1, 3, 4]);
  await connection.close();
});

test("getRequest: the messages page; an unknown id is empty with what to do", async () => {
  const connection = await connect({ transport: fdsApi() });
  const content = (await connection.call("getRequest", { id: 373204, limit: 3 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal((content["messages"] as unknown[]).length, 3);
  assert.equal(content["messageCount"], 8);
  assert.equal(content["nextOffset"], 3);
  assert.equal(content["source"], `${API}/api/v1/request/373204/`);
  const missing = (await connection.call("getRequest", { id: 1 })).structuredContent ?? {};
  assert.equal(missing["status"], "empty");
  assert.match(String(missing["reason"]), /doesn't exist or isn't public/);
  await connection.close();
});

test("getDocument: pages a few at a time", async () => {
  const connection = await connect({ transport: fdsApi() });
  const content = (await connection.call("getDocument", { id: 890, offset: 4 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual((content["pages"] as { number: number }[]).map((p) => p.number), [5]);
  assert.equal(content["pageCount"], 5);
  assert.equal(content["nextOffset"], undefined);
  await connection.close();
});

test("searchReference: tags as exact names; tags without a word is a tool error", async () => {
  const connection = await connect({ transport: fdsApi() });
  const content = (await connection.call("searchReference", { kind: "tags", query: "video" })).structuredContent ?? {};
  assert.deepEqual(content["items"], [{ name: "Videoüberwachung" }]);
  assert.equal((await connection.call("searchReference", { kind: "tags" })).isError, true);
  await connection.close();
});

test("--max-pages bounds the pages of 50 a tool reads of a list it reads whole: the campaigns", async () => {
  const topf = CAMPAIGNS.find((c) => c["id"] === 4) as JsonObject;
  const campaigns = [...Array.from({ length: 77 }, (_, i) => variant(topf, { id: 1000 + i, name: `Kampagne ${i}`, slug: `kampagne-${i}` })), topf];
  const transport = fdsApi({ campaigns });
  const one = await connect({ transport, config: { maxPages: 1 } });
  const cut = (await one.call("searchReference", { kind: "campaigns" })).structuredContent ?? {};
  assert.equal(cut["total"], 50);
  assert.match(JSON.stringify(cut["notes"]), /first 50 of 78 campaigns/);
  assert.equal(transport.calls.length, 1);
  await one.close();
  const all = await connect({ transport: fdsApi({ campaigns }) });
  const whole = (await all.call("searchReference", { kind: "campaigns", query: "Topf" })).structuredContent ?? {};
  assert.deepEqual((whole["items"] as { id: number }[]).map((c) => c.id), [4]);
  await all.close();
});
