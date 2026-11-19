// The use cases (operations.ts) against a mock of the FragDenStaat API on live answers recorded on
// 2026-11-19 (fds.ts), with the skills' traps as cases: names resolved to the ids, exact names or
// slugs each endpoint takes; a name fitting several is ambiguous, never guessed; nothing found
// says what was searched; the full-text search takes no status and counts at most 10000; a
// resolution counts only once resolved; a jurisdiction's laws miss the local statutes; every
// deadline has its unit; a tag is a slug for documents and an exact name for requests. Each answer
// keeps the requests it made, exactly as sent (its source).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FragDenStaatClient } from "../src/client.js";
import { FdsValidationError } from "../src/errors.js";
import {
  deadlineOf,
  findDocuments,
  findLaws,
  findPublicBody,
  findRequests,
  foldName,
  getDocument,
  getRequest,
  getRequestOutcomes,
  idFromUri,
  requestsOf,
  searchReference,
} from "../src/operations.js";
import { DOCUMENTS, fdsApi, REQUESTS, variant } from "./fds.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import type { JsonObject } from "../src/types.js";

const API = "https://fragdenstaat.de";

function setup(overrides: Parameters<typeof fdsApi>[0] = {}): { client: FragDenStaatClient; mock: MockTransport } {
  const mock = fdsApi(overrides);
  return { client: new FragDenStaatClient({ transport: mock.transport }), mock };
}

/** The answer's recorded requests are the requests the transport saw, in order. */
function assertTraced(answer: object, mock: MockTransport): string[] {
  const sent = mock.calls.map((call) => call.url.slice(API.length));
  assert.deepEqual(requestsOf(answer), sent);
  return sent;
}

test("findPublicBody by name: one hit is the profile, with the FOI email and the request note's absence said", async () => {
  const { client, mock } = setup();
  const answer = await findPublicBody(client, { name: " Umweltbundesamt " });
  assert.equal(answer.status, "ok");
  assert.ok("body" in answer);
  assert.equal(answer.body.id, 875);
  assert.equal(answer.body.email, "buergerservice@uba.de");
  assert.equal(answer.body.requestNote, null);
  assert.match(answer.body.address ?? "", /Platz\s1\n06844 Dessau$/, "CRLF made LF");
  assert.deepEqual(answer.body.jurisdiction, { id: 1, name: "Bund" });
  assert.ok(answer.body.laws.some((law) => law.id === 2 && law.meta));
  assert.match(answer.notes.join(" "), /no request note/);
  assert.deepEqual(assertTraced(answer, mock), ["/api/v1/publicbody/autocomplete/?limit=50&q=Umweltbundesamt", "/api/v1/publicbody/875/"]);
});

test("findPublicBody by a name that fits several: ambiguous with the candidates, no profile fetched", async () => {
  const { client, mock } = setup();
  const answer = await findPublicBody(client, { name: "Ministerium" });
  assert.equal(answer.status, "ambiguous");
  assert.ok("ambiguous" in answer);
  assert.equal(answer.ambiguous.field, "name");
  assert.equal(answer.ambiguous.total, 4);
  assert.equal(mock.calls.length, 1);
  const none = await findPublicBody(client, { name: "Bundesamt für Magie" });
  assert.equal(none.status, "empty");
  assert.match("reason" in none ? none.reason : "", /No public body's name holds/);
});

test("findPublicBody by an id goes straight to the profile; an unknown id is empty, not an error", async () => {
  const { client, mock } = setup();
  const answer = await findPublicBody(client, { name: "875" });
  assert.equal(answer.status, "ok");
  assert.deepEqual(assertTraced(answer, mock), ["/api/v1/publicbody/875/"]);
  assert.equal((await findPublicBody(client, { name: "999999" })).status, "empty");
});

test("findPublicBody by type and place: the names become ids, the faceted list takes the singular category; the subtree note", async () => {
  const { client, mock } = setup();
  const answer = await findPublicBody(client, { classification: "ministerium", jurisdiction: "Mecklenburg-Vorpommern", limit: 3 });
  assert.equal(answer.status, "ok");
  assert.ok("bodies" in answer);
  assert.deepEqual(answer.searched["jurisdiction"], { id: 7, name: "Mecklenburg-Vorpommern", slug: "mecklenburg-vorpommern" });
  assert.equal(answer.total, 5);
  assert.equal(answer.bodies.length, 3);
  assert.equal(answer.nextOffset, 3);
  assert.equal(answer.bodies[0]?.classification, "Ministerium");
  assert.match(answer.notes.join(" "), /whole subtree/);
  assert.deepEqual(assertTraced(answer, mock), [
    "/api/v1/jurisdiction/?limit=50",
    "/api/v1/classification/?q=ministerium&limit=50",
    "/api/v1/publicbody/?jurisdiction=7&classification=118&offset=0&limit=3",
  ]);
});

test("findPublicBody by words and a category: the full-text search, whose category is the plural categories", async () => {
  const { client, mock } = setup();
  const answer = await findPublicBody(client, { query: "Umwelt", category: "Umwelt" });
  assert.equal(answer.status, "empty", "the recorded bodies carry no category");
  assert.equal(mock.last().url, `${API}/api/v1/publicbody/search/?q=Umwelt&categories=9&offset=0&limit=20`);
  assertTraced(answer, mock);
});

test("findPublicBody by a point: lng,lat checked; a body found through two regions is listed once; not the nearest", async () => {
  const body = (await import("./fds.js")).PUBLIC_BODIES[1] as JsonObject;
  const { client, mock } = setup({ publicBodies: [body, body] });
  const answer = await findPublicBody(client, { point: "11.5755, 48.1372" });
  assert.ok("bodies" in answer);
  assert.equal(answer.bodies.length, 1);
  assert.equal(answer.duplicatesDropped, 1);
  assert.match(answer.notes.join(" "), /not the nearest/);
  assert.equal(mock.last().url, `${API}/api/v1/publicbody/?lnglat=11.5755%2C48.1372&offset=0&limit=20`);
  await assert.rejects(findPublicBody(client, { point: "Marienplatz" }), FdsValidationError);
  await assert.rejects(findPublicBody(client, { name: "UBA", jurisdiction: "Bund" }), /name looks one body up/);
  await assert.rejects(findPublicBody(client, {}), /give a name, or what to search by/);
});

test("a jurisdiction is matched exactly before by part: Sachsen is Sachsen, not Sachsen-Anhalt; 'sachs' fits several", async () => {
  const { client } = setup();
  const exact = await findLaws(client, { jurisdiction: "sachsen" });
  assert.deepEqual(exact.searched["jurisdiction"], { id: 89, name: "Sachsen", slug: "sachsen" });
  const several = await findPublicBody(client, { jurisdiction: "sachs" });
  assert.equal(several.status, "ambiguous");
  assert.ok("ambiguous" in several);
  assert.deepEqual(several.ambiguous.candidates.map((c) => c.name), ["Niedersachsen", "Sachsen", "Sachsen-Anhalt"]);
  const unknown = await findPublicBody(client, { jurisdiction: "München" });
  assert.equal(unknown.status, "empty");
  assert.match("reason" in unknown ? unknown.reason : "", /A town or district is no jurisdiction/);
});

test("findRequests by full text: only jurisdiction and category combine, as slugs; a status is refused before any request", async () => {
  const { client, mock } = setup();
  const answer = await findRequests(client, { query: "Überwachungskameras", jurisdiction: "NRW" });
  assert.equal(answer.status, "ok");
  assert.ok("requests" in answer);
  assert.deepEqual(answer.requests.map((r) => r.id), [2851, 3393]);
  assert.equal(answer.totalIsLowerBound, false);
  assert.equal(mock.last().url, `${API}/api/v1/request/search/?q=%C3%9Cberwachungskameras&jurisdiction=nrw&offset=0&limit=20`);
  assertTraced(answer, mock);
  const before = mock.calls.length;
  await assert.rejects(findRequests(client, { query: "Kameras", status: "resolved" }), /takes only jurisdiction and category; status need the list/);
  await assert.rejects(findRequests(client, { query: "Kameras", tag: "Videoüberwachung" }), FdsValidationError);
  assert.equal(mock.calls.length, before);
});

test("findRequests: a search total of 10000 is a lower bound", async () => {
  const mock = makeMockTransport(() => jsonResponse({ meta: { limit: 1, offset: 0, total_count: 10000, next: null, previous: null }, objects: [REQUESTS[0]] }));
  const answer = await findRequests(new FragDenStaatClient({ transport: mock.transport }), { query: "Polizei", limit: 1 });
  assert.ok("requests" in answer);
  assert.equal(answer.totalIsLowerBound, true);
  assert.match(answer.notes.join(" "), /at most 10000 hits/);
});

test("findRequests by facets: a tag is taken as spelled upstream; a resolution implies resolved; resolved_on's gap is said", async () => {
  const { client, mock } = setup();
  const answer = await findRequests(client, { tag: "videoüberwachung", resolution: "successful" });
  assert.equal(answer.status, "ok");
  assert.ok("requests" in answer);
  assert.deepEqual(answer.requests.map((r) => r.id), [373204, 356503, 308754]);
  assert.equal(answer.requests[0]?.resolution, "successful");
  assert.equal(answer.requests[0]?.publicBody?.name, "Polizei Hamburg");
  assert.equal(answer.requests[0]?.url, "https://fragdenstaat.de/anfrage/status-der-kamerasysteme-am-hansaplatz-20-06-2026/");
  assert.match(answer.notes.join(" "), /The tag is «?"?Videoüberwachung/);
  assert.match(answer.notes.join(" "), /implies status resolved/);
  assert.match(answer.notes.join(" "), /resolved_on is not filled/);
  assert.deepEqual(assertTraced(answer, mock), [
    "/api/v1/request/tags/autocomplete/?limit=50&q=video%C3%BCberwachung",
    "/api/v1/request/?status=resolved&resolution=successful&tags=Video%C3%BCberwachung&offset=0&limit=20",
  ]);
  await assert.rejects(findRequests(client, { status: "asleep", resolution: "refused" }), /only once a request is resolved/);
});

test("findRequests: an open request's resolution is null, not the API's empty string", async () => {
  const { client } = setup();
  const answer = await findRequests(client, { publicBody: "875" });
  assert.ok("requests" in answer);
  const open = answer.requests.find((r) => r.id === 383090);
  assert.equal(open?.status, "awaiting_classification");
  assert.equal(open?.resolution, null);
});

test("findRequests: a tag that doesn't exist is empty with the tags holding the word; a category is sent by its exact name", async () => {
  const { client, mock } = setup();
  const missing = await findRequests(client, { tag: "Video" });
  assert.equal(missing.status, "empty");
  assert.match("reason" in missing ? missing.reason : "", /No request tag is exactly .*Videoüberwachung/);
  assert.equal(mock.calls.length, 1, "no list request for a tag that doesn't exist");
  const category = await findRequests(client, { category: "umwelt" });
  assert.equal(category.status, "empty");
  assert.match(mock.last().url, /\/api\/v1\/request\/\?categories=Umwelt&offset=0&limit=20$/);
});

test("getRequestOutcomes: counts per resolution among the resolved only, with the rate", async () => {
  const { client, mock } = setup();
  const answer = await getRequestOutcomes(client, { tag: "Videoüberwachung" });
  assert.equal(answer.status, "ok");
  assert.ok("outcomes" in answer);
  assert.equal(answer.total, 5);
  assert.equal(answer.resolved, 5);
  assert.deepEqual(answer.outcomes, { successful: 3, partially_successful: 1, not_held: 1, refused: 0, user_withdrew_costs: 0, user_withdrew: 0 });
  assert.equal(answer.successRate, 80);
  assert.match(answer.verdict, /^5 of 5 requests resolved: 80% successful or partially successful/);
  assert.match(answer.notes.join(" "), /public requests only/);
  const sent = assertTraced(answer, mock);
  assert.equal(sent.length, 9, "the tag, the total, the resolved, six resolutions");
  assert.equal(sent[3], "/api/v1/request/?status=resolved&resolution=successful&tags=Video%C3%BCberwachung&limit=1");
});

test("getRequestOutcomes: none resolved means no rate and no per-resolution requests; nothing matching is empty", async () => {
  const open = variant(REQUESTS[0] as JsonObject, { id: 1, status: "awaiting_response", resolution: "", tags: ["Neu"] });
  const { client, mock } = setup({ requests: [open], tags: [{ value: "Neu", label: "Neu" }] });
  const answer = await getRequestOutcomes(client, { tag: "Neu" });
  assert.ok("outcomes" in answer);
  assert.equal(answer.successRate, null);
  assert.match(answer.verdict, /none resolved yet/);
  assert.equal(mock.calls.length, 3);
  const none = await getRequestOutcomes(client, { publicBody: "12345" });
  assert.equal(none.status, "empty");
});

test("findDocuments: an authority by name; metadata only; ids from the URIs", async () => {
  const { client, mock } = setup();
  const answer = await findDocuments(client, { publicBody: "Umweltbundesamt", limit: 2 });
  assert.equal(answer.status, "ok");
  assert.ok("documents" in answer);
  assert.equal(answer.total, 3);
  assert.equal(answer.nextOffset, 2);
  const [first] = answer.documents;
  assert.equal(first?.requestId, 160033);
  assert.equal(first?.publicBodyId, 875);
  assert.match(answer.notes.join(" "), /nothing is downloaded/);
  assert.deepEqual(assertTraced(answer, mock), ["/api/v1/publicbody/autocomplete/?limit=50&q=Umweltbundesamt", "/api/v1/document/?publicbody=875&offset=0&limit=2"]);
});

test("findDocuments: a tag is a slug, never a number; a scope is required", async () => {
  const { client, mock } = setup();
  await assert.rejects(findDocuments(client, { tag: "1" }), /takes a slug/);
  await assert.rejects(findDocuments(client, {}), /at least one scope/);
  assert.equal(mock.calls.length, 0);
  const answer = await findDocuments(client, { tag: "Lobbyismus" });
  assert.equal(answer.status, "empty");
  assert.match("reason" in answer ? answer.reason : "", /matched by its slug/);
  assert.equal(mock.last().url, `${API}/api/v1/document/?tag=lobbyismus&offset=0&limit=20`);
});

test("findDocuments by campaign: through its requests (no campaign filter on documents), with how many were looked through", async () => {
  const request = variant(REQUESTS[0] as JsonObject, { id: 157764, campaign: "https://fragdenstaat.de/api/v1/campaign/4/" });
  const { client, mock } = setup({ requests: [request] });
  const answer = await findDocuments(client, { campaign: "topf secret" });
  assert.equal(answer.status, "ok");
  assert.ok("documents" in answer);
  assert.deepEqual(answer.documents.map((d) => d.id), [890]);
  assert.equal(answer.campaignRequests, 1);
  assert.equal(answer.requestsScanned, 1);
  assert.deepEqual(assertTraced(answer, mock), ["/api/v1/campaign/?limit=50", "/api/v1/request/?campaign=4&limit=10", "/api/v1/document/?foirequest=157764&limit=50"]);
  await assert.rejects(findDocuments(client, { campaign: "4", request: 1 }), /not both/);
});

test("findLaws by jurisdiction: its laws with deadlines in words, and the note that local statutes are never among them", async () => {
  const { client, mock } = setup();
  const answer = await findLaws(client, { jurisdiction: "Bayern" });
  assert.equal(answer.status, "ok");
  assert.ok("laws" in answer);
  assert.equal(answer.total, 4);
  const press = answer.laws.find((l) => l.id === 166);
  assert.deepEqual(press?.deadline, { value: 5, unit: "working_day", text: "5 working days" });
  assert.equal(press?.jurisdiction, "Bayern");
  assert.match(answer.notes.join(" "), /Local statutes \(Satzungen\) have no jurisdiction/);
  assert.deepEqual(assertTraced(answer, mock), ["/api/v1/jurisdiction/?limit=50", "/api/v1/law/?jurisdiction=92&offset=0&limit=50"]);
});

test("findLaws by a town: the local statutes, which have no jurisdiction", async () => {
  const { client } = setup();
  const answer = await findLaws(client, { query: "München" });
  assert.ok("laws" in answer);
  assert.deepEqual(answer.laws.map((l) => [l.id, l.jurisdiction, l.deadline.text]), [
    [186, null, "30 days"],
    [51, null, "1 calendar month (counted as German calendar months)"],
  ]);
});

test("findLaws by one law: a meta law names the laws it bundles; the statute text is measured and excerpted", async () => {
  const { client, mock } = setup();
  const meta = await findLaws(client, { law: "2" });
  assert.ok("law" in meta);
  assert.equal(meta.law.meta, true);
  assert.deepEqual(meta.law.combined.map((c) => c.id), [1, 3, 4]);
  assert.equal(meta.law.combined[0]?.name, "Informationsfreiheitsgesetz Bund (IFG)");
  assert.equal(meta.law.legalTextChars, 0);
  assert.match(meta.notes.join(" "), /no statute text/);
  assert.deepEqual(assertTraced(meta, mock), ["/api/v1/jurisdiction/?limit=50", "/api/v1/law/2/", "/api/v1/law/?jurisdiction=1&limit=50"]);
  const ifg = await findLaws(client, { law: "Informationsfreiheitsgesetz Bund (IFG)" });
  assert.ok("law" in ifg);
  assert.equal(ifg.law.id, 1);
  assert.equal(ifg.law.legalTextChars, 2500);
  assert.equal([...(ifg.law.legalTextExcerpt ?? "")].length, 2001);
  const several = await findLaws(client, { law: "Umweltinformationsgesetz" });
  assert.equal(several.status, "ambiguous");
  await assert.rejects(findLaws(client, { law: "1", jurisdiction: "Bund" }), /law looks one law up/);
});

test("deadlines always carry their unit in words", () => {
  assert.equal(deadlineOf(1, "month_de").text, "1 calendar month (counted as German calendar months)");
  assert.equal(deadlineOf(20, "working_day").text, "20 working days");
  assert.equal(deadlineOf(null, "").text, "no deadline set");
  assert.equal(deadlineOf(3, "fortnight").text, "3 fortnight");
});

test("getRequest: the correspondence with the redacted texts and the attachments' pages, no signed file links", async () => {
  const { client } = setup();
  const answer = await getRequest(client, { id: "373204" });
  assert.equal(answer.status, "ok");
  assert.ok("messages" in answer);
  assert.equal(answer.messageCount, 8);
  assert.equal(answer.request.law?.deadline.text, "1 calendar month (counted as German calendar months)");
  assert.equal(answer.request.publicBody?.name, "Polizei Hamburg");
  const reply = answer.messages[1];
  assert.equal(reply?.isResponse, true);
  assert.match(reply?.content ?? "", /^Sehr \[geschwärzt\],/);
  assert.equal(reply?.attachments[0]?.isRedacted, true);
  assert.doesNotMatch(JSON.stringify(answer), /token=/);
  const missing = await getRequest(client, { id: 1 });
  assert.equal(missing.status, "empty");
  await assert.rejects(getRequest(client, { id: "abc" }), FdsValidationError);
});

test("getDocument: the pages' text, with the OCR caveat", async () => {
  const { client, mock } = setup();
  const answer = await getDocument(client, { id: 890 });
  assert.ok("pages" in answer);
  assert.equal(answer.pageCount, 5);
  assert.match(answer.pages[0]?.content ?? "", /^Für Mensch & Umwelt/);
  assert.equal(answer.document.requestId, 157764);
  assert.match(answer.notes.join(" "), /OCR/);
  assert.deepEqual(assertTraced(answer, mock), ["/api/v1/document/890/"]);
  const listed = DOCUMENTS.find((d) => d["id"] === 9319) as JsonObject;
  const bare = await getDocument(setup({ documents: [listed] }).client, { id: 9319 });
  assert.ok("pages" in bare);
  assert.match(bare.notes.join(" "), /no page text/);
});

test("searchReference: the names and ids the filters take; tags need a word", async () => {
  const { client } = setup();
  const campaigns = await searchReference(client, { kind: "campaigns", query: "topf" });
  assert.ok("items" in campaigns);
  assert.deepEqual(campaigns.items.map((c) => [c.id, c.name, c["active"]])[0], [4, "Topf Secret", true]);
  const all = await searchReference(client, { kind: "jurisdictions", limit: 5 });
  assert.ok("items" in all);
  assert.equal(all.total, 18);
  assert.equal(all.nextOffset, 5);
  const tags = await searchReference(client, { kind: "tags", query: "video" });
  assert.ok("items" in tags);
  assert.deepEqual(tags.items, [{ name: "Videoüberwachung" }]);
  await assert.rejects(searchReference(client, { kind: "tags" }), /looked up by a word/);
  const none = await searchReference(client, { kind: "categories", query: "Raumfahrt" });
  assert.equal(none.status, "empty");
});

test("helpers: ids from resource URIs; names folded for comparing", () => {
  assert.equal(idFromUri("https://fragdenstaat.de/api/v1/law/124/"), 124);
  assert.equal(idFromUri(null), null);
  assert.equal(foldName("Thüringen"), foldName("thueringen"));
  assert.equal(foldName(" Baden-Württemberg "), "baden wuerttemberg");
});
