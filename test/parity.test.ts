// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FragDenStaatClient } from "../src/client/client.js";
import { FdsValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import { parity, type CliOutcome, type LibOutcome } from "./helpers.js";

const lib = (transport: Transport) => new FragDenStaatClient({ transport });

/** Both sides reject before any request; the library with FdsValidationError. */
function assertBothReject(r: { cli: CliOutcome; lib: LibOutcome }, message?: string): void {
  assert.equal(r.cli.code, 1, `CLI exit code (stderr: ${r.cli.err})`);
  assert.deepEqual(r.cli.requests, [], "CLI sent no request");
  assert.equal(r.lib.ok, false, "library rejected");
  assert.deepEqual(r.lib.requests, [], "library sent no request");
  const error = (r.lib as { error: unknown }).error;
  assert.ok(error instanceof FdsValidationError, `library error class: ${String(error)}`);
  if (message !== undefined) assert.equal(error.message, message);
}

/** Both sides succeed with the identical request. */
function assertSameRequest(r: { cli: CliOutcome; lib: LibOutcome }): void {
  assert.equal(r.cli.code, 0, `CLI exit code (stderr: ${r.cli.err})`);
  assert.equal(r.lib.ok, true, `library outcome: ${String((r.lib as { error?: unknown }).error)}`);
  assert.equal(r.cli.requests.length, 1);
  assert.deepEqual(
    r.lib.requests.map((q) => q.url),
    r.cli.requests.map((q) => q.url),
  );
}

// --- Finding 3 (PAT-9): blank filter and query values ---------------------------

test("parity: a blank filter value is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "list", "--jurisdiction", ""], (t) => lib(t).requests.list({ jurisdiction: "" })),
    "Invalid jurisdiction: Expected a non-empty value.",
  );
  assertBothReject(
    await parity(["request", "list", "--csv", "--law", ""], (t) => lib(t).requests.listCsv({ law: "" })),
  );
  assertBothReject(
    await parity(["category", "list", "--name", " "], (t) => lib(t).categories.list({ name: " " })),
  );
  assertBothReject(
    await parity(["georegion", "list", "--csv", "--slug", ""], (t) => lib(t).georegions.listCsv({ slug: "" })),
  );
  assertBothReject(
    await parity(["message", "list", "--request", ""], (t) => lib(t).messages.list({ request: "" })),
  );
  assertBothReject(
    await parity(["document", "list", "--csv", "--tag", " "], (t) => lib(t).documents.listCsv({ tag: " " })),
  );
  assertBothReject(
    await parity(["request", "search", "--q", " "], (t) => lib(t).requests.search({ q: " " })),
  );
  assertBothReject(
    await parity(["publicbody", "search", "--category", ""], (t) =>
      lib(t).publicBodies.search({ categories: "" }),
    ),
  );
});

test("parity: a blank autocomplete or tags query is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "tags", ""], (t) => lib(t).requests.tagsAutocomplete("")),
    "Invalid q: Expected a non-empty value.",
  );
  assertBothReject(
    await parity(["publicbody", "autocomplete", "   "], (t) => lib(t).publicBodies.autocomplete("   ")),
  );
  assertBothReject(await parity(["law", "autocomplete", ""], (t) => lib(t).laws.autocomplete("")));
  assertBothReject(
    await parity(["georegion", "autocomplete", ""], (t) => lib(t).georegions.autocomplete("")),
  );
});

test("parity: a non-blank filter value is sent the same way by CLI and library", async () => {
  assertSameRequest(
    await parity(["request", "list", "--jurisdiction", "5"], (t) => lib(t).requests.list({ jurisdiction: "5" })),
  );
  assertSameRequest(
    await parity(["request", "tags", "lob"], (t) => lib(t).requests.tagsAutocomplete("lob")),
  );
});

// --- Finding 1 (PAT-10): resource ids in get <id> -------------------------------

test("parity: a non-numeric id is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "get", "search"], (t) => lib(t).requests.get("search")),
    "Invalid id: Expected a numeric id (digits only).",
  );
  assertBothReject(
    await parity(["publicbody", "get", "autocomplete"], (t) => lib(t).publicBodies.get("autocomplete")),
  );
  assertBothReject(
    await parity(["jurisdiction", "get", ""], (t) => lib(t).jurisdictions.get("")),
    "Invalid id: Expected a non-empty value.",
  );
  assertBothReject(await parity(["message", "get", " 10 "], (t) => lib(t).messages.get(" 10 ")));
  assertBothReject(await parity(["request", "get", "1?x=1"], (t) => lib(t).requests.get("1?x=1")));
  assertBothReject(await parity(["law", "get", "1.5"], (t) => lib(t).laws.get(1.5)));
  assertBothReject(await parity(["law", "get", "-1"], (t) => lib(t).laws.get(-1)));
  assertBothReject(await parity(["law", "get", "NaN"], (t) => lib(t).laws.get(NaN)));
  assertBothReject(await parity(["request", "get", ".."], (t) => lib(t).requests.get("..")));
});

test("parity: a numeric id fetches the same detail path", async () => {
  assertSameRequest(await parity(["request", "get", "42"], (t) => lib(t).requests.get("42")));
  assertSameRequest(await parity(["law", "get", "42"], (t) => lib(t).laws.get(42)));
});

// --- Finding 8 (PAT-12): enum and boolean list filters --------------------------

/** An untyped params object, as plain-JS callers or JSON input would pass it. */
const untyped = (params: Record<string, unknown>): any => params;

test("parity: a value outside an enum filter's choices is rejected by CLI and library", async () => {
  const r = await parity(["request", "list", "--status=Resolved"], (t) =>
    lib(t).requests.list(untyped({ status: "Resolved" })),
  );
  assertBothReject(r);
  assert.match(String((r.lib as { error: Error }).error.message), /^Invalid status: Allowed choices are awaiting_user_confirmation, /);
  assertBothReject(
    await parity(["request", "list", "--csv", "--status=Resolved"], (t) =>
      lib(t).requests.listCsv(untyped({ status: "Resolved" })),
    ),
  );
  assertBothReject(
    await parity(["request", "list", "--resolution", "won"], (t) =>
      lib(t).requests.list(untyped({ resolution: "won" })),
    ),
  );
  assertBothReject(
    await parity(["message", "list", "--kind", "Email"], (t) => lib(t).messages.list(untyped({ kind: "Email" }))),
  );
  assertBothReject(
    await parity(["georegion", "list", "--kind", "State"], (t) =>
      lib(t).georegions.list(untyped({ kind: "State" })),
    ),
  );
  assertBothReject(
    await parity(["request", "list", "--status", ""], (t) => lib(t).requests.list(untyped({ status: "" }))),
  );
});

test("parity: a non-boolean value for a boolean filter is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "list", "--is-foi=yes"], (t) => lib(t).requests.list(untyped({ is_foi: "yes" }))),
    "Invalid is_foi: Expected a boolean (true or false).",
  );
  assertBothReject(
    await parity(["request", "list", "--checked", ""], (t) => lib(t).requests.list(untyped({ checked: "" }))),
  );
  assertBothReject(
    await parity(["law", "list", "--meta", "yes"], (t) => lib(t).laws.list(untyped({ meta: "yes" }))),
  );
  assertBothReject(
    await parity(["category", "list", "--is-topic", "1"], (t) => lib(t).categories.list(untyped({ is_topic: "1" }))),
  );
  assertBothReject(
    await parity(["message", "list", "--is-response", "no"], (t) =>
      lib(t).messages.list(untyped({ is_response: "no" })),
    ),
  );
});

test("parity: valid enum and boolean filters are sent the same way", async () => {
  assertSameRequest(
    await parity(["request", "list", "--status=resolved", "--is-foi"], (t) =>
      lib(t).requests.list({ status: "resolved", is_foi: true }),
    ),
  );
  assertSameRequest(
    await parity(["message", "list", "--kind", "email", "--is-response", "false"], (t) =>
      lib(t).messages.list({ kind: "email", is_response: false }),
    ),
  );
});

// --- Finding 4 (PAT-11): offset/limit ranges -------------------------------------

test("parity: a limit outside 1..50 is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "list", "--limit", "500"], (t) => lib(t).requests.list({ limit: 500 })),
    "Invalid limit: Must be <= 50.",
  );
  assertBothReject(
    await parity(["request", "list", "--limit", "0"], (t) => lib(t).requests.list({ limit: 0 })),
    "Invalid limit: Must be >= 1.",
  );
  assertBothReject(
    await parity(["publicbody", "list", "--limit", "NaN"], (t) => lib(t).publicBodies.list({ limit: NaN })),
    "Invalid limit: Expected an integer.",
  );
  assertBothReject(
    await parity(["category", "list", "--csv", "--limit", "51"], (t) => lib(t).categories.listCsv({ limit: 51 })),
  );
  assertBothReject(
    await parity(["law", "autocomplete", "x", "--limit", "51"], (t) => lib(t).laws.autocomplete("x", { limit: 51 })),
  );
  assertBothReject(
    await parity(["publicbody", "search", "--q", "x", "--csv", "--limit", "1.5"], (t) =>
      lib(t).publicBodies.searchCsv({ q: "x", limit: 1.5 }),
    ),
  );
});

test("parity: an offset that is not a non-negative integer is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "list", "--offset", "-1"], (t) => lib(t).requests.list({ offset: -1 })),
    "Invalid offset: Expected a non-negative integer.",
  );
  assertBothReject(
    await parity(["request", "search", "--q", "x", "--offset", "1.5"], (t) =>
      lib(t).requests.search({ q: "x", offset: 1.5 }),
    ),
  );
  assertBothReject(
    await parity(["campaign", "list", "--offset", "Infinity"], (t) => lib(t).campaigns.list({ offset: Infinity })),
  );
  assertBothReject(
    await parity(["request", "list", "--offset", "100000000000000000000"], (t) =>
      lib(t).requests.list({ offset: 1e20 }),
    ),
  );
  assertBothReject(
    await parity(["request", "tags", "x", "--offset", "-1"], (t) => lib(t).requests.tagsAutocomplete("x", { offset: -1 })),
  );
  assertBothReject(
    await parity(["georegion", "autocomplete", "x", "--offset", "-1"], (t) =>
      lib(t).georegions.autocomplete("x", { offset: -1 }),
    ),
  );
});

test("parity: an in-range page is sent the same way", async () => {
  assertSameRequest(
    await parity(["request", "list", "--limit", "50", "--offset", "100"], (t) =>
      lib(t).requests.list({ offset: 100, limit: 50 }),
    ),
  );
  assertSameRequest(
    await parity(["category", "autocomplete", "x", "--limit", "1", "--offset", "0"], (t) =>
      lib(t).categories.autocomplete("x", { offset: 0, limit: 1 }),
    ),
  );
});

// --- Finding 2 (PAT-17): point filters --------------------------------------------

test("parity: a malformed or out-of-range point is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["publicbody", "list", "--lnglat", "Berlin"], (t) => lib(t).publicBodies.list({ lnglat: "Berlin" })),
    'Invalid lnglat: Expected "lng,lat" as two decimal numbers, e.g. 12.37,51.34.',
  );
  assertBothReject(
    await parity(["publicbody", "list", "--lnglat", "51.34,120"], (t) =>
      lib(t).publicBodies.list({ lnglat: "51.34,120" }),
    ),
    "Invalid lnglat: Latitude 120 is out of range (-90..90); the order is lng,lat.",
  );
  assertBothReject(
    await parity(["publicbody", "list", "--csv", "--lnglat", " 12.37,51.34"], (t) =>
      lib(t).publicBodies.listCsv({ lnglat: " 12.37,51.34" }),
    ),
  );
  assertBothReject(
    await parity(["georegion", "list", "--latlng", "120,50"], (t) => lib(t).georegions.list({ latlng: "120,50" })),
    "Invalid latlng: Latitude 120 is out of range (-90..90); the order is lat,lng.",
  );
  assertBothReject(
    await parity(["georegion", "list", "--latlng", "50,200"], (t) => lib(t).georegions.list({ latlng: "50,200" })),
    "Invalid latlng: Longitude 200 is out of range (-180..180); the order is lat,lng.",
  );
  assertBothReject(
    await parity(["georegion", "list", "--latlng", "abc", "--csv"], (t) => lib(t).georegions.listCsv({ latlng: "abc" })),
  );
  assertBothReject(
    await parity(["georegion", "list", "--latlng", "  "], (t) => lib(t).georegions.list({ latlng: "  " })),
    "Invalid latlng: Expected a non-empty value.",
  );
});

test("parity: a valid point is sent the same way", async () => {
  assertSameRequest(
    await parity(["georegion", "list", "--latlng", "51.34,12.37"], (t) =>
      lib(t).georegions.list({ latlng: "51.34,12.37" }),
    ),
  );
  assertSameRequest(
    await parity(["publicbody", "list", "--lnglat", "12.37,51.34"], (t) =>
      lib(t).publicBodies.list({ lnglat: "12.37,51.34" }),
    ),
  );
});

// --- Finding 6 (PAT-5): the User-Agent value -------------------------------------

test("parity: a blank, control-character or non-Latin-1 User-Agent is rejected by CLI and library", async () => {
  const withUa = (userAgent: string) => (t: Transport) =>
    new FragDenStaatClient({ transport: t, userAgent }).laws.list({ limit: 1 });
  assertBothReject(
    await parity(["--user-agent", "", "law", "list", "--limit", "1"], withUa("")),
    "Invalid userAgent: Expected a non-empty value.",
  );
  assertBothReject(await parity(["--user-agent", "  ", "law", "list"], withUa("  ")));
  assertBothReject(
    await parity(["--user-agent", "a\r\nX-Evil: 1", "law", "list"], withUa("a\r\nX-Evil: 1")),
    "Invalid userAgent: Value contains control characters.",
  );
  assertBothReject(await parity(["--user-agent", "a\u007fb", "law", "list"], withUa("a\u007fb")));
  assertBothReject(
    await parity(["--user-agent", "agent→", "law", "list"], withUa("agent→")),
    "Invalid userAgent: Value contains characters outside Latin-1 (above U+00FF).",
  );
});

test("parity: a valid User-Agent is sent the same way", async () => {
  const ua = "my-agent é\tx";
  const r = await parity(["--user-agent", ua, "law", "list"], (t) =>
    new FragDenStaatClient({ transport: t, userAgent: ua }).laws.list(),
  );
  assertSameRequest(r);
  assert.equal(r.cli.requests[0]?.headers?.["User-Agent"], ua);
  assert.equal(r.lib.requests[0]?.headers?.["User-Agent"], ua);
});

// --- Finding 7 (PAT-1): base URL with whitespace ----------------------------------

test("parity: a base URL with whitespace or control characters is rejected by CLI and library", async () => {
  const withBase = (baseUrl: string) => (t: Transport) =>
    new FragDenStaatClient({ transport: t, baseUrl }).laws.list({ limit: 1 });
  for (const baseUrl of ["https://x.test/ ", " https://x.test", "https://x.test\n", "\thttps://x.test/"]) {
    assertBothReject(
      await parity(["--base-url", baseUrl, "law", "list", "--limit", "1"], withBase(baseUrl)),
      "Invalid baseUrl: A base URL cannot have surrounding whitespace.",
    );
  }
  for (const baseUrl of ["https://x.test/a b", "https://x.test/p\tq", "https://x.test/p\u0000q"]) {
    assertBothReject(
      await parity(["--base-url", baseUrl, "law", "list", "--limit", "1"], withBase(baseUrl)),
      "Invalid baseUrl: A base URL cannot contain whitespace or control characters.",
    );
  }
});

test("parity: a clean base URL is used the same way", async () => {
  assertSameRequest(
    await parity(["--base-url", "https://x.test/", "law", "list", "--limit", "1"], (t) =>
      new FragDenStaatClient({ transport: t, baseUrl: "https://x.test/" }).laws.list({ limit: 1 }),
    ),
  );
});

// --- Finding 5 (PAT-16): law id filters and request cost filters ------------------

test("parity: a law id filter that is not a non-negative integer is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["law", "list", "--jurisdiction", "abc"], (t) => lib(t).laws.list({ jurisdiction: "abc" })),
    "Invalid jurisdiction: Expected a non-negative integer.",
  );
  assertBothReject(
    await parity(["law", "list", "--jurisdiction", ""], (t) => lib(t).laws.list({ jurisdiction: "" })),
    "Invalid jurisdiction: Expected a non-empty value.",
  );
  assertBothReject(await parity(["law", "list", "--id", "abc"], (t) => lib(t).laws.list({ id: "abc" })));
  assertBothReject(await parity(["law", "list", "--mediator", "x1"], (t) => lib(t).laws.list({ mediator: "x1" })));
  for (const v of [" 5", "1.5", "-1", "0x10", "99999999999999999999"]) {
    assertBothReject(await parity(["law", "list", "--jurisdiction", v], (t) => lib(t).laws.list({ jurisdiction: v })));
  }
  assertBothReject(await parity(["law", "list", "--jurisdiction", "1.5"], (t) => lib(t).laws.list({ jurisdiction: 1.5 })));
  assertBothReject(
    await parity(["law", "list", "--csv", "--jurisdiction", "abc"], (t) => lib(t).laws.listCsv({ jurisdiction: "abc" })),
  );
});

test("parity: law id filters are sent in canonical form by CLI and library", async () => {
  const r = await parity(["law", "list", "--jurisdiction", "007", "--id", "12"], (t) =>
    lib(t).laws.list({ jurisdiction: "007", id: "12" }),
  );
  assertSameRequest(r);
  assert.equal(new URL(r.lib.requests[0]!.url).search, "?jurisdiction=7&id=12");
  assertSameRequest(await parity(["law", "list", "--jurisdiction", "5"], (t) => lib(t).laws.list({ jurisdiction: 5 })));
});

test("parity: a cost filter that is not a finite non-negative number is rejected by CLI and library", async () => {
  assertBothReject(
    await parity(["request", "list", "--costs-min", "-5"], (t) => lib(t).requests.list({ costs_min: -5 })),
    "Invalid costs_min: Expected a non-negative number.",
  );
  assertBothReject(
    await parity(["request", "list", "--costs-max", "NaN"], (t) => lib(t).requests.list({ costs_max: NaN })),
  );
  assertBothReject(
    await parity(["request", "list", "--costs-min", "9".repeat(400)], (t) =>
      lib(t).requests.list({ costs_min: Infinity }),
    ),
  );
});

test("parity: a valid cost filter is sent the same way", async () => {
  assertSameRequest(
    await parity(["request", "list", "--costs-max", "12.50"], (t) => lib(t).requests.list({ costs_max: 12.5 })),
  );
});

// --- Finding 9 (PAT-2): one base-URL rule set, a validation error --------------

test("parity: a malformed base URL is rejected by CLI and library with the same reason", async () => {
  const withBase = (baseUrl: string) => (t: Transport) =>
    new FragDenStaatClient({ transport: t, baseUrl }).jurisdictions.list();
  const cases: Array<[string, string]> = [
    ["ftp://x.example", 'Unsupported protocol "ftp:" (use http or https).'],
    ["file:///etc/passwd", 'Unsupported protocol "file:" (use http or https).'],
    ["https://h.example/?q=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/#f", "A base URL cannot have a query (?) or fragment (#)."],
    ["", 'Invalid URL "".'],
    ["not-a-url", 'Invalid URL "not-a-url".'],
    ["https://u:secret@h.example/?q", "A base URL cannot have a query (?) or fragment (#)."],
  ];
  for (const [baseUrl, reason] of cases) {
    const r = await parity(["--base-url", baseUrl, "jurisdiction", "list"], withBase(baseUrl));
    assertBothReject(r, `Invalid baseUrl: ${reason}`);
    assert.ok(r.cli.err.includes(reason), `CLI reason for ${JSON.stringify(baseUrl)}: ${r.cli.err}`);
  }
});
