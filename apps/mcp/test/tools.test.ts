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
import { DEADLINE_HINT, SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { CAMPAIGNS, DOCUMENTS, fdsApi, REQUEST_373204, variant } from "./helpers.js";
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

test("getDocument: a page's text comes whole up to 20000 characters; the size cap pages through pages, never cutting one that fits", async () => {
  const doc = DOCUMENTS.find((d) => d["id"] === 890) as JsonObject;
  const text = (n: number, end: string): string => `${"Seite ".repeat(Math.ceil(n / 6)).slice(0, n - end.length)}${end}`;
  const pages = [
    { number: 1, content: text(9000, "Ergebnis: 4711 Euro.") },
    { number: 2, content: text(9000, "Fazit zwei.") },
    { number: 3, content: text(30000, "unerreichbar") },
  ];
  const connection = await connect({ transport: fdsApi({ documents: [variant(doc, { pages })] }) });
  const first = (await connection.call("getDocument", { id: 890 })).structuredContent ?? {};
  const got = first["pages"] as { number: number; content: string }[];
  assert.equal(got[0]?.content.length, 9000);
  assert.match(got[0]?.content ?? "", /Ergebnis: 4711 Euro\.$/);
  assert.equal(first["nextOffset"], got.length, "the cap moved the rest to the next page");
  const second = (await connection.call("getDocument", { id: 890, offset: 1, limit: 1 })).structuredContent ?? {};
  assert.match((second["pages"] as { content: string }[])[0]?.content ?? "", /Fazit zwei\.$/);
  assert.equal(second["truncated"], undefined);
  const long = (await connection.call("getDocument", { id: 890, offset: 2, limit: 1 })).structuredContent ?? {};
  assert.equal(long["truncated"], true);
  assert.match((long["pages"] as { content: string }[])[0]?.content ?? "", /…\[cut, 30000 characters in all\]$/);
  await connection.close();
});

test("getRequest: the request's text, its summary and each message come whole up to 20000 characters", async () => {
  const long = (n: number, end: string): string => `${"Wort ".repeat(Math.ceil(n / 5)).slice(0, n - end.length)}${end}`;
  const messages = (REQUEST_373204["messages"] as JsonObject[]).map((m, i) => (i === 1 ? variant(m, { content: long(4945, "Ende der Antwort."), redacted_content: [[false, long(4945, "Ende der Antwort.")]] }) : m));
  const request = variant(REQUEST_373204, { description: long(4004, "Ende der Frage."), redacted_description: [[false, long(4004, "Ende der Frage.")]], summary: long(3000, "Ende der Zusammenfassung."), messages });
  const connection = await connect({ transport: fdsApi({ requests: [request] }) });
  const content = (await connection.call("getRequest", { id: 373204, limit: 2 })).structuredContent ?? {};
  const got = content["request"] as { description: string; summary: string };
  assert.match(got.description, /Ende der Frage\.$/);
  assert.match(got.summary, /Ende der Zusammenfassung\.$/);
  const answer = (content["messages"] as { content: string; contentChars: number }[])[1];
  assert.equal(answer?.content.length, 4945);
  assert.equal(answer?.contentChars, 4945);
  assert.equal(content["truncated"], undefined);
  await connection.close();
});

test("the deadline and size advice name each option with the tools that take it, and every one of them does", () => {
  for (const hint of [DEADLINE_HINT, SIZE_HINT]) {
    const named = [...hint.matchAll(/\(([a-zA-Z]+(?:, [a-zA-Z]+)*): ([a-zA-Z]+(?:, [a-zA-Z]+)*)\)/g)];
    assert.ok(named.length > 0, hint);
    for (const [, options, tools] of named) {
      for (const tool of (tools as string).split(", ")) {
        const schema = TOOLS.find((t) => t.name === tool)?.inputSchema as { properties: Record<string, unknown> } | undefined;
        assert.ok(schema !== undefined, `${tool} is a tool`);
        for (const option of (options as string).split(", ")) assert.ok(option in schema.properties, `${tool} takes ${option}`);
      }
    }
  }
  assert.doesNotMatch(DEADLINE_HINT, /getRequestOutcomes\)[^.]*limit/);
  assert.match(DEADLINE_HINT, /getRequestOutcomes/, "the tool that makes the most requests gets its own advice");
});
