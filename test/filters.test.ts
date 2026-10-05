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
