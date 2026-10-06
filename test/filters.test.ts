// The per-endpoint parameter tables (src/client/filters.ts), with the repros of the
// 2026-10-05 exploratory findings: filters the API would ignore or drop never go out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FragDenStaatClient } from "../src/client/client.js";
import { FdsValidationError } from "../src/client/errors.js";
import { normalizeIdList } from "../src/client/filters.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

function lib() {
  const mt = makeMockTransport(() => jsonResponse(fx.requestList));
  return { c: new FragDenStaatClient({ transport: mt.transport }), mt };
}

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() => jsonResponse(fx.requestList));
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: (opts) => new FragDenStaatClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

const query = (url: string): string => new URL(url).search;

// Result 01 bug 1: a non-integer element made the server drop the whole id filter.
test("georegion id and document ids must be integer lists, in the library and the CLI", async () => {
  for (const [label, call] of [
    ["georegion id abc", (c: FragDenStaatClient) => c.georegions.list({ id: "abc" })],
    ["georegion id 1.5", (c: FragDenStaatClient) => c.georegions.list({ id: "1.5" })],
    ["document ids 26,abc", (c: FragDenStaatClient) => c.documents.list({ ids: "26,abc" })],
    ["document ids 26;27", (c: FragDenStaatClient) => c.documents.list({ ids: "26;27" })],
    ["document ids abc", (c: FragDenStaatClient) => c.documents.listCsv({ ids: "abc" })],
  ] as const) {
    const { c, mt } = lib();
    await assert.rejects(call(c), (e: unknown) => e instanceof FdsValidationError && /comma-separated list of numeric ids/.test((e as Error).message), label);
    assert.equal(mt.calls.length, 0, label);
  }
  for (const argv of [
    ["georegion", "list", "--id", "abc"],
    ["georegion", "list", "--id", "1.5"],
    ["document", "list", "--ids", "26,abc"],
    ["document", "list", "--ids", "26;27"],
    ["document", "list", "--ids", "26", "--ids", "abc"],
  ]) {
    const r = cli();
    assert.equal(await run(argv, r.deps), 1, argv.join(" "));
    assert.equal(r.mt.calls.length, 0, argv.join(" "));
    assert.match(r.err.join("\n"), /Expected a comma-separated list of numeric ids/);
  }
  const ok = cli();
  assert.equal(await run(["document", "list", "--ids", "26, 27", "--ids", "28"], ok.deps), 0);
  assert.equal(query(ok.mt.last().url), "?ids=26%2C27%2C28");
  assert.equal(normalizeIdList([26, "027"]), "26,27");
});

// Result 01 bug 3: `--regions abc` made the server answer HTTP 500.
test("publicbody --regions takes an id or an id list; a word is a usage error before any request", async () => {
  const bad = cli();
  assert.equal(await run(["publicbody", "list", "--regions", "abc"], bad.deps), 1);
  assert.equal(bad.mt.calls.length, 0);
  const { c, mt } = lib();
  await assert.rejects(c.publicBodies.list({ regions: "abc" }), FdsValidationError);
  assert.equal(mt.calls.length, 0);
  await c.publicBodies.list({ regions: [1, 2] });
  assert.equal(query(mt.last().url), "?regions=1%2C2");
});

// Result 04 bug 1: arrays were sent as repeated keys, of which the server keeps the last.
test("an array where the API reads one value is rejected; multiple-choice filters repeat the key", async () => {
  const { c, mt } = lib();
  for (const params of [{ jurisdiction: [1, 91] }, { status: ["resolved", "asleep"] }, { is_foi: [true] }, { tags: ["a", "b"] }]) {
    await assert.rejects(
      c.requests.list(params as never),
      (e: unknown) => e instanceof FdsValidationError && /Expected a single value, not a list/.test((e as Error).message),
      JSON.stringify(params),
    );
  }
  assert.equal(mt.calls.length, 0);
  await c.publicBodies.list({ category: [1, "2"] });
  assert.equal(query(mt.last().url), "?category=1&category=2");
  await c.publicBodies.search({ regions: [3, 4] });
  assert.equal(query(mt.last().url), "?regions=3&regions=4");
});

// Result 04 bug 2: unknown and misspelled keys went out unchecked.
test("an unknown key is rejected with a suggestion; allowUnknownFilters sends it", async () => {
  const { c, mt } = lib();
  await assert.rejects(c.publicBodies.search({ q: "amt", category: 9 } as never), /did you mean "categories"\?/);
  await assert.rejects(c.requests.list({ jurisdicton: 1 } as never), /did you mean "jurisdiction"\?/);
  await assert.rejects(c.requests.list({ Status: "resolved" } as never), /did you mean "status"\?/);
  await assert.rejects(c.requests.list(JSON.parse('{"__proto__": {"x": 1}}') as never), FdsValidationError);
  await assert.rejects(c.classifications.list({ is_topic: true } as never), FdsValidationError);
  await assert.rejects(c.requests.list("jurisdiction=1" as never), /Expected an object of query parameters/);
  assert.equal(mt.calls.length, 0);
  await c.requests.list({ new_filter: "x" } as never, { allowUnknownFilters: true });
  assert.equal(query(mt.last().url), "?new_filter=x");
  await assert.rejects(c.requests.list({ new_filter: { a: 1 } } as never, { allowUnknownFilters: true }), FdsValidationError);
});

test("id filters are checked and sent as numbers; campaign '-' means no campaign", async () => {
  const { c, mt } = lib();
  await c.requests.list({ jurisdiction: "007", public_body: 93, campaign: "-" });
  assert.equal(query(mt.last().url), "?jurisdiction=7&public_body=93&campaign=-");
  for (const params of [{ jurisdiction: "bayern" }, { law: {} }, { user: Number.NaN }, { campaign: "x" }]) {
    await assert.rejects(c.requests.list(params as never), FdsValidationError, JSON.stringify(params));
  }
  const r = cli();
  assert.equal(await run(["request", "list", "--jurisdiction", "bayern"], r.deps), 1);
  assert.equal(await run(["request", "list", "--campaign", "-"], r.deps), 0);
  assert.equal(query(r.mt.last().url), "?campaign=-");
});

test("request categories and classification are sent as the names given", async () => {
  const r = cli();
  assert.equal(await run(["request", "list", "--categories", "Umwelt", "--classification", "Ministerium"], r.deps), 0);
  assert.equal(query(r.mt.last().url), "?categories=Umwelt&classification=Ministerium");
});

// Result 01 bug 2 / result 06 bug 1: --categories and --classification take names.
test("an empty request list under a name filter prints a note naming it", async () => {
  const empty = { meta: { limit: 50, next: null, offset: 0, previous: null, total_count: 0 }, objects: [] };
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() => jsonResponse(empty));
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: (opts) => new FragDenStaatClient({ ...opts, transport: mt.transport }),
  };
  assert.equal(await run(["request", "list", "--categories", "umwelt", "--status", "resolved"], deps), 0);
  assert.match(err.join("\n"), /--categories "umwelt" takes the exact category name, e.g\. "Umwelt"/);
  err.length = 0;
  assert.equal(await run(["request", "list", "--status", "resolved"], deps), 0);
  assert.deepEqual(err, []);
  const full = cli();
  assert.equal(await run(["request", "list", "--classification", "Ministerium"], full.deps), 0);
  assert.deepEqual(full.err, []);
});

// Follow-up 2026-10-06, answer 1: upstream, a single --regions id that doesn't exist filters
// nothing (every public body comes back). Each id is looked up first; a 404 is an error.
function regionsLib(known: number[]) {
  const mt = makeMockTransport((req) => {
    const m = /\/api\/v1\/georegion\/(\d+)\/$/.exec(new URL(req.url).pathname);
    if (m) {
      return known.includes(Number(m[1]))
        ? jsonResponse({ id: Number(m[1]), name: "Leipzig" })
        : jsonResponse({ detail: "No GeoRegion matches the given query." }, 404);
    }
    return jsonResponse(fx.requestList);
  });
  return { c: new FragDenStaatClient({ transport: mt.transport }), mt };
}

test("a --regions id the API doesn't know rejects before the list, naming it; known ids are looked up first", async () => {
  const single = regionsLib([]);
  await assert.rejects(
    single.c.publicBodies.list({ regions: 999999999 }),
    (e: unknown) =>
      e instanceof FdsValidationError &&
      (e as Error).message ===
        "Invalid regions: no geo-region has the id 999999999 (the API would ignore the filter and list every public body). " +
          "Look a region up by name first (georegion autocomplete / georegions.autocomplete()).",
  );
  assert.deepEqual(single.mt.calls.map((r) => new URL(r.url).pathname), ["/api/v1/georegion/999999999/"]);

  const list = regionsLib([26]);
  await assert.rejects(
    list.c.publicBodies.listCsv({ regions: "26,98,99" }),
    /no geo-region has the ids 98, 99 \(the API would match nothing for them\)/,
  );
  assert.equal(list.mt.calls.length, 3, "one lookup per id, then no list request");

  const search = regionsLib([3]);
  await assert.rejects(search.c.publicBodies.search({ regions: [3, 4] }), /no geo-region has the id 4 \(the API would match nothing for it\)/);
  await assert.rejects(search.c.publicBodies.searchCsv({ regions: 4 }), /the id 4 \(the API would ignore the filter/);

  const ok = regionsLib([26, 27]);
  await ok.c.publicBodies.list({ regions: "26, 27" });
  assert.deepEqual(ok.mt.calls.map((r) => new URL(r.url).pathname + new URL(r.url).search), [
    "/api/v1/georegion/26/",
    "/api/v1/georegion/27/",
    "/api/v1/publicbody/?regions=26%2C27",
  ]);
});

test("a lookup that fails otherwise propagates; no regions filter means no lookup", async () => {
  const mt = makeMockTransport(() => jsonResponse({ detail: "boom" }, 500));
  const c = new FragDenStaatClient({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(c.publicBodies.list({ regions: 26 }), (e: unknown) => !(e instanceof FdsValidationError) && /HTTP 500/.test(String(e)));
  const { c: plain, mt: plainMt } = lib();
  await plain.publicBodies.list({ jurisdiction: 1 });
  assert.equal(plainMt.calls.length, 1);
});

test("publicbody list --regions with an unknown id exits 1 naming it, before the list request", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const { mt } = regionsLib([]);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: (opts) => new FragDenStaatClient({ ...opts, transport: mt.transport }),
  };
  assert.equal(await run(["publicbody", "list", "--regions", "424242"], deps), 1);
  assert.deepEqual(out, []);
  assert.match(err.join("\n"), /^Error: Invalid regions: no geo-region has the id 424242 /);
  assert.equal(mt.calls.length, 1);
});
