// Conformance test P24 (trend analysis 2026-10-21; fix plan 2026-10-21, D8 and D10): an input
// is canonicalised or refused, never sent raw. One corpus of tricky values goes through every
// text filter, every token (id, code, enum, sort key) and every list the repo declares, on the
// CLI and in the library. Either both refuse it before any request (exit 2, the validation
// error), or both send the same request with the value in canonical form: a text without
// surrounding whitespace, in composed Unicode, never blank; a token as the adapter canonicalises
// it, never empty, a dot segment or with a "/"; a list item by item. A value that holds only
// invisible characters or combining marks is blank. A refusal shows an invisible or control
// character escaped (`\u200b`), never raw. Each value here was once sent raw by some *-cli and
// matched nothing, or the wrong thing, with exit 0. Shared across the *-cli repos; only the
// adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/fragdenstaat-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
/**
 * `parity(argv, call, responder)`: argv through run() and `call` through the library, each on a
 * recording mock transport; resolves to `{ cli: { code, out, err, requests }, lib: { ok, value?,
 * error?: { name, message }, requests } }`. Map the repo's own helper to this shape if it differs.
 * This repo's `parity` returns the library's error itself: `kitParity` maps it.
 */
import { jsonResponse, kitParity as parity } from "./helpers.js";
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 1;
import { FragDenStaatClient as Client } from "@maschinenlesbar.org/fragdenstaat-client/internal/client";
interface Input<T = string | null> {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => T;
}
const q = (u: URL): string | null => u.searchParams.get("q");
const param = (name: string) => (u: URL): string | null => u.searchParams.get(name);
/**
 * Every text filter, and every token sent as a query parameter (slugs, `--reference`,
 * `--region-identifier`, the dates): a token's canonical form is the text test's (trimmed, NFC),
 * and it refuses the inner format characters text allows (ZWJ), which the test accepts as a
 * refusal on both sides.
 */
const textInputs: Input[] = [
  { name: "request list --categories", argv: (v) => ["request", "list", "--categories", v], lib: (c, v) => c.requests.list({ categories: v }), sent: param("categories") },
  { name: "request list --classification", argv: (v) => ["request", "list", "--classification", v], lib: (c, v) => c.requests.list({ classification: v }), sent: param("classification") },
  { name: "request list --tags", argv: (v) => ["request", "list", "--tags", v], lib: (c, v) => c.requests.list({ tags: v }), sent: param("tags") },
  { name: "request list --reference", argv: (v) => ["request", "list", "--reference", v], lib: (c, v) => c.requests.list({ reference: v }), sent: param("reference") },
  { name: "request list --slug", argv: (v) => ["request", "list", "--slug", v], lib: (c, v) => c.requests.list({ slug: v }), sent: param("slug") },
  { name: "request list --created-after", argv: (v) => ["request", "list", "--created-after", v], lib: (c, v) => c.requests.list({ created_at_after: v }), sent: param("created_at_after") },
  { name: "request search --q", argv: (v) => ["request", "search", "--q", v], lib: (c, v) => c.requests.search({ q: v }), sent: q },
  { name: "request search --jurisdiction", argv: (v) => ["request", "search", "--jurisdiction", v], lib: (c, v) => c.requests.search({ jurisdiction: v }), sent: param("jurisdiction") },
  { name: "request search --category", argv: (v) => ["request", "search", "--category", v], lib: (c, v) => c.requests.search({ category: v }), sent: param("category") },
  { name: "request tags", argv: (v) => ["request", "tags", v], lib: (c, v) => c.requests.tagsAutocomplete(v), sent: q },
  { name: "publicbody list --q", argv: (v) => ["publicbody", "list", "--q", v], lib: (c, v) => c.publicBodies.list({ q: v }), sent: q },
  { name: "publicbody list --slug", argv: (v) => ["publicbody", "list", "--slug", v], lib: (c, v) => c.publicBodies.list({ slug: v }), sent: param("slug") },
  { name: "publicbody search --q", argv: (v) => ["publicbody", "search", "--q", v], lib: (c, v) => c.publicBodies.search({ q: v }), sent: q },
  { name: "publicbody autocomplete", argv: (v) => ["publicbody", "autocomplete", v], lib: (c, v) => c.publicBodies.autocomplete(v), sent: q },
  { name: "law list --q", argv: (v) => ["law", "list", "--q", v], lib: (c, v) => c.laws.list({ q: v }), sent: q },
  { name: "law autocomplete", argv: (v) => ["law", "autocomplete", v], lib: (c, v) => c.laws.autocomplete(v), sent: q },
  { name: "category list --q", argv: (v) => ["category", "list", "--q", v], lib: (c, v) => c.categories.list({ q: v }), sent: q },
  { name: "category list --name", argv: (v) => ["category", "list", "--name", v], lib: (c, v) => c.categories.list({ name: v }), sent: param("name") },
  { name: "category autocomplete", argv: (v) => ["category", "autocomplete", v], lib: (c, v) => c.categories.autocomplete(v), sent: q },
  { name: "classification list --q", argv: (v) => ["classification", "list", "--q", v], lib: (c, v) => c.classifications.list({ q: v }), sent: q },
  { name: "classification list --name", argv: (v) => ["classification", "list", "--name", v], lib: (c, v) => c.classifications.list({ name: v }), sent: param("name") },
  { name: "georegion list --q", argv: (v) => ["georegion", "list", "--q", v], lib: (c, v) => c.georegions.list({ q: v }), sent: q },
  { name: "georegion list --name", argv: (v) => ["georegion", "list", "--name", v], lib: (c, v) => c.georegions.list({ name: v }), sent: param("name") },
  { name: "georegion list --kind-detail", argv: (v) => ["georegion", "list", "--kind-detail", v], lib: (c, v) => c.georegions.list({ kind_detail: v }), sent: param("kind_detail") },
  { name: "georegion list --region-identifier", argv: (v) => ["georegion", "list", "--region-identifier", v], lib: (c, v) => c.georegions.list({ region_identifier: v }), sent: param("region_identifier") },
  { name: "georegion list --slug", argv: (v) => ["georegion", "list", "--slug", v], lib: (c, v) => c.georegions.list({ slug: v }), sent: param("slug") },
  { name: "georegion autocomplete", argv: (v) => ["georegion", "autocomplete", v], lib: (c, v) => c.georegions.autocomplete(v), sent: q },
  { name: "document list --tag", argv: (v) => ["document", "list", "--tag", v], lib: (c, v) => c.documents.list({ tag: v }), sent: param("tag") },
  { name: "document list --created-before", argv: (v) => ["document", "list", "--created-before", v], lib: (c, v) => c.documents.list({ created_at_before: v }), sent: param("created_at_before") },
];
/** The detail path's id segment (`/api/v1/<resource>/<id>/`). */
const idSegment = (u: URL): string => decodeURIComponent(u.pathname.split("/").filter((s) => s !== "").pop() ?? "");
/** Every token that goes into a request path (sent as its last segment): every `get`. */
const idInputs: Input[] = (
  [
    ["request", (c, v) => c.requests.get(v)],
    ["publicbody", (c, v) => c.publicBodies.get(v)],
    ["law", (c, v) => c.laws.get(v)],
    ["jurisdiction", (c, v) => c.jurisdictions.get(v)],
    ["category", (c, v) => c.categories.get(v)],
    ["classification", (c, v) => c.classifications.get(v)],
    ["campaign", (c, v) => c.campaigns.get(v)],
    ["georegion", (c, v) => c.georegions.get(v)],
    ["message", (c, v) => c.messages.get(v)],
    ["document", (c, v) => c.documents.get(v)],
  ] as Array<[string, (c: Client, v: string) => Promise<unknown>]>
).map(([group, lib]) => ({ name: `${group} get`, argv: (v: string) => [group, "get", v], lib, sent: idSegment }));
/**
 * Every comma-separated list option: none the corpus fits. This API's lists (`document --ids`,
 * `georegion --id`, `publicbody --regions`) are numeric ids, so every item of LIST_CORPUS ("a1")
 * is refused; `validate.test.ts` checks them item by item (an empty or invisible item refuses
 * the whole list).
 */
const listInputs: Array<Input<string[] | null>> = [];
/** The id as the repo sends it. Ids are digits only, as typed (no padding is accepted). */
const canonicalId = (value: string): string => value.trim().normalize("NFC");
/** A valid answer to any of these requests: a Tastypie list, which also passes as a record. */
const respond = (req: HttpRequest): HttpResponse => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").filter((s) => s !== "").pop() ?? "");
  return jsonResponse({ meta: { limit: 50, next: null, offset: 0, previous: null, total_count: 1 }, objects: [{ id: 1 }], id });
};
// --------------------------------------------------------------------------------------

/** Values every input refuses: blank, only invisible characters or combining marks, a lone surrogate, a control or format character. */
const REFUSED = [
  "", " ", "\u00a0", "\n\t", "\u3000", "\u200b", "\u00ad", "\u200d", "\ufeff", "\u0301\u0308", " \u200b ",
  "a\u200bb", "M\u00fcl\u00adler", "\u202eabc", "a\u0000b", "a\u001bb", "a\u0085b", "\ud800", "a\udc00b", "x\ud83d",
];
const TEXT_CORPUS = [
  "Müller", "Mu\u0308ller", "  Müller  ", "\u00a0Müller\u00a0", "Müller\n", "\tMüller", "a  b", "A\u030a",
  "ﬁ", "x".repeat(5000), "\u3000x", "😀 smile", "a\u200db",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "%2e%2e", "a b", "e\u0301"];
const LIST_REFUSED = ["", ",", " , ", "a1,,a2", "a1,", ",a1", "a1,\u200b", "a1,a\u200bb", "\ud800,a1"];
const LIST_CORPUS = ["a1", "a1,a2", " a1 , a2 ", "e\u0301,a2", "a1,a1"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error?.message)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

/** A control, format or lone-surrogate character in `value`, or undefined. */
const INVISIBLE = /[\p{Cc}\p{Cf}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/** A refusal of `value` shows its invisible character as an escape on both sides, never raw (D10). */
function refusedVisibly(o: Outcome, value: string, label: string): void {
  const blank = value.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "") === "";
  const ch = INVISIBLE.exec(value.trim())?.[0];
  if (ch === undefined || blank) return;
  const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  assert.ok(o.cli.err.toLowerCase().includes(escape), `${label}: the CLI's refusal doesn't show ${escape}: ${o.cli.err}`);
  assert.ok(!o.cli.err.includes(ch), `${label}: the CLI's refusal shows the character raw`);
  assert.ok((o.lib.error?.message ?? "").toLowerCase().includes(escape), `${label}: the library's refusal doesn't show ${escape}: ${o.lib.error?.message}`);
}

const short = (value: string): string => JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value);

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${short(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: every input refuses a blank, invisible, control or half character, before any request, showing it escaped", async () => {
  const inputs = [...textInputs, ...idInputs];
  for (const input of inputs) {
    for (const value of REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}, sent ${o.cli.requests.map((r) => r.url).join(" ")}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value, label);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});

test("P24: a list is canonicalised item by item; an empty or invisible item refuses the whole list", async () => {
  for (const input of listInputs) {
    for (const value of LIST_REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value.split(",").find((item) => INVISIBLE.test(item)) ?? "", label);
    }
    for (const value of LIST_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      assert.ok(url !== undefined, `${label}: refused`);
      assert.deepEqual(input.sent(url), value.split(",").map(canonicalId), label);
    }
  }
});
