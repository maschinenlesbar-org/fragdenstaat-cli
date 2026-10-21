// The CLI logs each retry as one WARN record of `fragdenstaat.http`; stdout is the same as
// without the retry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { FragDenStaatClient } from "@maschinenlesbar.org/fragdenstaat-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "@maschinenlesbar.org/fragdenstaat-client/internal/http";
import { jurisdictionList } from "@maschinenlesbar.org/fragdenstaat-client/test/fixtures";
import { untimed } from "./helpers.js";

async function exercise(extra: string[], failures: number, retryAfter?: string) {
  const out: string[] = [];
  const err: string[] = [];
  let n = 0;
  const transport = async (): Promise<HttpResponse> =>
    n++ < failures
      ? { status: 503, headers: retryAfter ? { "retry-after": retryAfter } : {}, body: Buffer.from("{}") }
      : { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(jurisdictionList)) };
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    now: () => new Date("2026-01-02T03:04:05.678Z"),
    createClient: (opts) => new FragDenStaatClient({ ...opts, transport, sleep: async () => {} }),
  };
  const code = await run([...extra, "jurisdiction", "list"], deps);
  return { code, out: out.join("\n"), err };
}

test("a 503 then 200 exits 0, same stdout, and logs one WARN of fragdenstaat.http", async () => {
  const plain = await exercise([], 0);
  const retried = await exercise(["--base-url", "https://mirror.test", "--max-retries", "2"], 1, "2");
  assert.equal(retried.code, 0);
  assert.equal(retried.out, plain.out);
  assert.equal(plain.err.length, 0);
  assert.deepEqual(untimed(retried.err.join("\n")).split("\n"), [
    "WARN  [fragdenstaat.http] HTTP 503 from mirror.test: retry 1 of 2 in 2 s",
  ]);
});

test("the same record in jsonl, with the delay in ms under one second", async () => {
  const r = await exercise(["--log-format", "jsonl", "--max-retries", "2"], 1);
  assert.equal(r.code, 0);
  assert.equal(r.err.length, 1);
  const rec = JSON.parse(r.err[0] as string) as Record<string, unknown>;
  assert.equal(rec["level"], "WARN");
  assert.equal(rec["topic"], "fragdenstaat.http");
  assert.match(String(rec["msg"]), /^HTTP 503 from [a-z0-9.-]+: retry 1 of 2 in 200 ms$/);
});

// Exploratory test 2026-10-21, bug 04-1: the last record after spent retries was a bare "socket hang up".
test("a reset that persists through the retries ends in an ERROR that says it was retried", async () => {
  const err: string[] = [];
  const transport = async (): Promise<HttpResponse> => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  const deps: CliDeps = {
    io: { out: () => {}, err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: (opts) => new FragDenStaatClient({ ...opts, transport, sleep: async () => {} }),
  };
  assert.equal(await run(["--max-retries", "2", "jurisdiction", "list"], deps), 1);
  const records = err.map(untimed);
  assert.equal(records.length, 3, records.join("\n"));
  assert.match(records[0] ?? "", /^WARN  \[fragdenstaat\.http\] connection reset from fragdenstaat\.de: retry 1 of 2/);
  assert.equal(records[2], "ERROR [fragdenstaat.http] GET https://fragdenstaat.de/api/v1/jurisdiction/ failed: socket hang up (after 2 retries)");
});
