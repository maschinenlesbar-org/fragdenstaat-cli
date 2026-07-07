import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { FragDenStaatClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new FragDenStaatClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, files, mt };
}

test("request list sends filters and prints JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "list", "--status", "resolved", "--limit", "5"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), fx.requestList);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/api/v1/request/");
  assert.equal(url.searchParams.get("status"), "resolved");
  assert.equal(url.searchParams.get("limit"), "5");
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  await run(["--compact", "request", "list", "--limit", "1"], cli.deps);
  assert.equal(cli.out.length, 1);
  assert.equal(cli.out[0], JSON.stringify(fx.requestList));
});

test("boolean filter --is-foi false is sent as false", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  await run(["request", "list", "--is-foi", "false"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("is_foi"), "false");
});

test("bare boolean flag --checked is sent as true", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  await run(["request", "list", "--checked"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("checked"), "true");
});

test("an invalid --status choice is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "list", "--status", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--limit above the server cap (50) is rejected client-side", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "list", "--limit", "100"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("an out-of-range boolean value is rejected, not silently dropped", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "list", "--is-foi", "maybe"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0); // never issued an (unfiltered) request
  assert.match(cli.err.join("\n"), /Expected "true" or "false"/);
});

test("request search enforces the same --limit cap as list", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "search", "--q", "x", "--limit", "100"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("request search rejects a negative offset", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "search", "--q", "x", "--offset", "-5"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("publicbody search hits /search/ and enforces the --limit cap", async () => {
  const ok = makeCli(() => jsonResponse(fx.publicBodyList));
  assert.equal(await run(["publicbody", "search", "--q", "umwelt", "--limit", "5"], ok.deps), 0);
  assert.equal(new URL(ok.mt.last().url).pathname, "/api/v1/publicbody/search/");

  const bad = makeCli(() => jsonResponse(fx.publicBodyList));
  assert.notEqual(await run(["publicbody", "search", "--q", "x", "--limit", "999"], bad.deps), 0);
  assert.equal(bad.mt.calls.length, 0);
});

test("request search --csv negotiates CSV on the /search/ path", async () => {
  const cli = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  const code = await run(["request", "search", "--q", "umwelt", "--csv"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  assert.equal(new URL(req.url).pathname, "/api/v1/request/search/");
  assert.equal(new URL(req.url).searchParams.get("format"), "csv");
  assert.equal(req.headers?.["Accept"], "text/csv");
});

test("request get hits the detail path", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestDetail));
  const code = await run(["request", "get", "1"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api/v1/request/1/");
});

test("a 404 exits with code 4 and prints the detail to stderr", async () => {
  const cli = makeCli(() => jsonResponse(fx.notFound, 404));
  const code = await run(["request", "get", "999999999"], cli.deps);
  assert.equal(code, 4);
  assert.match(cli.err.join("\n"), /No FoiRequest matches the given query/);
  assert.equal(cli.out.length, 0);
});

test("a 400 validation error exits 1 and surfaces the field message", async () => {
  const cli = makeCli(() => jsonResponse(fx.documentTag400, 400));
  const code = await run(["document", "list", "--tag", "foo"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /tag: Bitte eine gültige Auswahl/);
});

test("request list --csv streams CSV to stdout and requests format=csv", async () => {
  const cli = makeCli(() => rawResponse(fx.csvBody, "text/csv; charset=utf-8"));
  const code = await run(["request", "list", "--limit", "2", "--csv"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join(""), fx.csvBody);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("format"), "csv");
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to stdout \(Content-Type: text\/csv/);
});

test("--output writes CSV to a file and keeps stdout clean", async () => {
  const cli = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  const code = await run(
    ["--output", "/tmp/out.csv", "request", "list", "--csv"],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.equal(cli.files.get("/tmp/out.csv")?.toString("utf8"), fx.csvBody);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to \/tmp\/out\.csv/);
});

test("publicbody autocomplete hits the autocomplete endpoint", async () => {
  const cli = makeCli(() => jsonResponse(fx.autocomplete));
  const code = await run(["publicbody", "autocomplete", "umwelt"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/api/v1/publicbody/autocomplete/");
  assert.equal(url.searchParams.get("q"), "umwelt");
});

test("global --base-url is honoured", async () => {
  const cli = makeCli(() => jsonResponse(fx.jurisdictionList));
  await run(["--base-url", "https://example.test", "jurisdiction", "list"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).origin, "https://example.test");
});

test("a non-http --base-url is rejected at parse time before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.jurisdictionList));
  const code = await run(["--base-url", "ftp://example.test", "jurisdiction", "list"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Unsupported protocol/);
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--help"], cli.deps);
  assert.equal(code, 0);
});

// --- Regression tests for bugs found in exploratory testing (see findings.md) ---
// The shared shape here is "bad input is rejected before any request is issued":
// a non-zero exit code AND `mt.calls.length === 0` (nothing reached the network).

// #1 — the search endpoint rejects every value of its old --status choice set, so
// the option was removed rather than left as a filter that can never succeed.
test("request search no longer offers the always-failing --status option", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "search", "--q", "wasser", "--status", "resolved"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /unknown option '--status'/);
});

// #2 — a non-numeric id used to be forwarded and silently ignored by the server,
// returning the full unfiltered list with exit 0.
test("law list --id rejects a non-numeric value instead of silently dropping the filter", async () => {
  const cli = makeCli(() => jsonResponse(fx.lawList));
  const code = await run(["law", "list", "--id", "abc"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("law list --id forwards a valid numeric id", async () => {
  const cli = makeCli(() => jsonResponse(fx.lawList));
  const code = await run(["law", "list", "--id", "145"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("id"), "145");
});

// #3 — --costs-* were free-form, so non-numeric input reached the server as a 400.
test("request list --costs-min rejects a non-numeric amount before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "list", "--costs-min", "notanumber"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("request list --costs-min accepts a decimal EUR amount", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["request", "list", "--costs-min", "12.50"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("costs_min"), "12.5");
});

// #4 — a blank <query> used to be sent as an empty q= and returned the whole dataset.
test("publicbody autocomplete rejects a whitespace-only query", async () => {
  const cli = makeCli(() => jsonResponse(fx.autocomplete));
  const code = await run(["publicbody", "autocomplete", "   "], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("request tags rejects an empty query", async () => {
  const cli = makeCli(() => jsonResponse(fx.tagsAutocomplete));
  const code = await run(["request", "tags", ""], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

// #5 — an empty -o used to fall through to stdout because "" is falsy.
test("empty --output is rejected rather than silently falling back to stdout", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  const code = await run(["--output", "", "request", "list", "--limit", "1"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.equal(cli.out.length, 0);
});

// #6 — a CR/LF --user-agent used to surface via the generic "Unexpected error:" catch-all.
test("a control-char --user-agent is rejected with a clean error, not 'Unexpected error:'", async () => {
  const cli = makeCli(() => jsonResponse(fx.jurisdictionList));
  const code = await run(
    ["--user-agent", "evil\r\nX-Injected: 1", "jurisdiction", "list"],
    cli.deps,
  );
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  const errText = cli.err.join("\n");
  assert.match(errText, /control characters/);
  assert.doesNotMatch(errText, /Unexpected error/);
});

test("a normal --user-agent is forwarded as the User-Agent header", async () => {
  const cli = makeCli(() => jsonResponse(fx.jurisdictionList));
  const code = await run(["--user-agent", "my-cli/1.0", "jurisdiction", "list"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "my-cli/1.0");
});
