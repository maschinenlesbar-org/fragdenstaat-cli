// Conformance test P24 (trend analysis 2026-10-21): an input is canonicalised or refused, never
// sent raw. One corpus of tricky values goes through every text filter and every id the repo
// declares, on the CLI and in the library. Either both refuse it before any request (exit 2,
// the validation error), or both send the same request with the value in canonical form: a
// text without surrounding whitespace, in composed Unicode, never blank; an id as the adapter
// canonicalises it, never empty, a dot segment or with a "/". Each value here was once sent raw
// by some *-cli and matched nothing, or the wrong thing, with exit 0. Shared across the *-cli
// repos; only the adapter differs.

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
interface Input {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => string | null;
}
const q = (u: URL): string | null => u.searchParams.get("q");
/**
 * Every text filter (sent as a query parameter). Slugs (`--slug`, `document --tag`, request
 * search `--jurisdiction`/`--category`), `--reference` and `--region-identifier` are not text:
 * they go out as typed.
 */
const textInputs: Input[] = [
  { name: "request list --categories", argv: (v) => ["request", "list", "--categories", v], lib: (c, v) => c.requests.list({ categories: v }), sent: (u) => u.searchParams.get("categories") },
  { name: "request list --classification", argv: (v) => ["request", "list", "--classification", v], lib: (c, v) => c.requests.list({ classification: v }), sent: (u) => u.searchParams.get("classification") },
  { name: "request list --tags", argv: (v) => ["request", "list", "--tags", v], lib: (c, v) => c.requests.list({ tags: v }), sent: (u) => u.searchParams.get("tags") },
  { name: "request search --q", argv: (v) => ["request", "search", "--q", v], lib: (c, v) => c.requests.search({ q: v }), sent: q },
  { name: "request tags", argv: (v) => ["request", "tags", v], lib: (c, v) => c.requests.tagsAutocomplete(v), sent: q },
  { name: "publicbody list --q", argv: (v) => ["publicbody", "list", "--q", v], lib: (c, v) => c.publicBodies.list({ q: v }), sent: q },
  { name: "publicbody search --q", argv: (v) => ["publicbody", "search", "--q", v], lib: (c, v) => c.publicBodies.search({ q: v }), sent: q },
  { name: "publicbody autocomplete", argv: (v) => ["publicbody", "autocomplete", v], lib: (c, v) => c.publicBodies.autocomplete(v), sent: q },
  { name: "law list --q", argv: (v) => ["law", "list", "--q", v], lib: (c, v) => c.laws.list({ q: v }), sent: q },
  { name: "law autocomplete", argv: (v) => ["law", "autocomplete", v], lib: (c, v) => c.laws.autocomplete(v), sent: q },
  { name: "category list --q", argv: (v) => ["category", "list", "--q", v], lib: (c, v) => c.categories.list({ q: v }), sent: q },
  { name: "category list --name", argv: (v) => ["category", "list", "--name", v], lib: (c, v) => c.categories.list({ name: v }), sent: (u) => u.searchParams.get("name") },
  { name: "category autocomplete", argv: (v) => ["category", "autocomplete", v], lib: (c, v) => c.categories.autocomplete(v), sent: q },
  { name: "classification list --q", argv: (v) => ["classification", "list", "--q", v], lib: (c, v) => c.classifications.list({ q: v }), sent: q },
  { name: "classification list --name", argv: (v) => ["classification", "list", "--name", v], lib: (c, v) => c.classifications.list({ name: v }), sent: (u) => u.searchParams.get("name") },
  { name: "georegion list --q", argv: (v) => ["georegion", "list", "--q", v], lib: (c, v) => c.georegions.list({ q: v }), sent: q },
  { name: "georegion list --name", argv: (v) => ["georegion", "list", "--name", v], lib: (c, v) => c.georegions.list({ name: v }), sent: (u) => u.searchParams.get("name") },
  { name: "georegion list --kind-detail", argv: (v) => ["georegion", "list", "--kind-detail", v], lib: (c, v) => c.georegions.list({ kind_detail: v }), sent: (u) => u.searchParams.get("kind_detail") },
  { name: "georegion autocomplete", argv: (v) => ["georegion", "autocomplete", v], lib: (c, v) => c.georegions.autocomplete(v), sent: q },
];
/** The detail path's id segment (`/api/v1/<resource>/<id>/`). */
const idSegment = (u: URL): string => decodeURIComponent(u.pathname.split("/").filter((s) => s !== "").pop() ?? "");
/** Every id that goes into a request path (sent as its last segment): every `get`. */
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
 * The id as the repo sends it. Ids are digits only, as typed (no padding is accepted), so
 * every value of the shared corpus is refused on both sides.
 */
const canonicalId = (value: string): string => value.trim();
/** A valid answer to any of these requests: a Tastypie list, which also passes as a record. */
const respond = (req: HttpRequest): HttpResponse => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").filter((s) => s !== "").pop() ?? "");
  return jsonResponse({ meta: { limit: 50, next: null, offset: 0, previous: null, total_count: 1 }, objects: [{ id: 1 }], id });
};
// --------------------------------------------------------------------------------------

const TEXT_CORPUS = [
  "Müller", "Müller", "  Müller  ", " Müller ", "Müller\n", "\tMüller", "a  b", "Å",
  "ﬁ", "x".repeat(5000), "", " ", " ", "\n\t", "　",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "", "  ", "%2e%2e", "a b"];

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
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (value.trim() === "") {
        assert.equal(url, undefined, `${label}: a blank value was sent (it reads as "no filter")`);
        continue;
      }
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
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
