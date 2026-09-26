import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { FragDenStaatClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import { countCsvRows } from "../src/cli/shared.js";
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
      writeFile: (p, d, exclusive) => {
        // Mirror the real fs `wx` behaviour: an exclusive write to an existing
        // path fails with an EEXIST error rather than overwriting.
        if (exclusive && files.has(p)) {
          const e = new Error(`EEXIST: file already exists, open '${p}'`) as NodeJS.ErrnoException;
          e.code = "EEXIST";
          throw e;
        }
        files.set(p, d);
      },
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { ...fx.requestDetail, title: `Anfrage${controls}`, description: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "request", "get", "1"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Anfrage\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
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

// FDS-02 — -o must not silently clobber an existing file; --force opts back in.
test("--output refuses to overwrite an existing file without --force", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  cli.files.set("/tmp/exists.json", Buffer.from("keep me"));
  const code = await run(["--output", "/tmp/exists.json", "request", "list", "--limit", "1"], cli.deps);
  assert.notEqual(code, 0);
  // The existing file is untouched, and the message points at --force.
  assert.equal(cli.files.get("/tmp/exists.json")?.toString("utf8"), "keep me");
  assert.match(cli.err.join("\n"), /refusing to overwrite/);
  assert.match(cli.err.join("\n"), /--force/);
  assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
});

test("--output --force overwrites an existing file", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  cli.files.set("/tmp/exists.json", Buffer.from("old"));
  const code = await run(
    ["--output", "/tmp/exists.json", "--force", "request", "list", "--limit", "1"],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.files.get("/tmp/exists.json")!.toString("utf8")), fx.requestList);
});

test("--output --force overwrites an existing CSV file", async () => {
  const cli = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  cli.files.set("/tmp/out.csv", Buffer.from("stale"));
  const code = await run(
    ["--output", "/tmp/out.csv", "--force", "request", "list", "--csv"],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.equal(cli.files.get("/tmp/out.csv")?.toString("utf8"), fx.csvBody);
});

// FDS-01 — a hostile/MITM'd upstream can lace "CSV" with ANSI/OSC escape
// sequences. When --csv prints to the terminal (stdout, no -o) the escape/control
// bytes must be stripped while the CSV field/record separators (tab, CR, LF)
// survive; the -o file path must keep the bytes verbatim.
test("--csv to stdout strips terminal escape bytes but keeps CSV structure", async () => {
  const ESC = String.fromCharCode(0x1b); // never a raw literal in source
  const NUL = String.fromCharCode(0x00);
  // An OSC 52 clipboard-write plus a stray NUL embedded in a normal CSV cell.
  const hostileCsv =
    "id,title\r\n1," + ESC + "]52;c;ZXZpbA==" + String.fromCharCode(0x07) + "safe" + NUL + "\r\n";
  const cli = makeCli(() => rawResponse(hostileCsv, "text/csv"));
  const code = await run(["request", "list", "--csv"], cli.deps);
  assert.equal(code, 0);
  const printed = cli.out.join("");
  // No ESC, BEL, or NUL reaches the terminal.
  assert.ok(!printed.includes(ESC));
  assert.ok(!printed.includes(String.fromCharCode(0x07)));
  assert.ok(!printed.includes(NUL));
  // CSV structure (CRLF record separators, comma fields) and the visible text survive.
  assert.ok(printed.includes("id,title\r\n"));
  assert.ok(printed.includes("safe"));
});

test("--csv to a file keeps escape bytes verbatim (only the terminal is at risk)", async () => {
  const ESC = String.fromCharCode(0x1b);
  const hostileCsv = "id\r\n" + ESC + "]52;c;x\r\n";
  const cli = makeCli(() => rawResponse(hostileCsv, "text/csv"));
  const code = await run(["--output", "/tmp/raw.csv", "request", "list", "--csv"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.files.get("/tmp/raw.csv")?.toString("utf8"), hostileCsv);
  assert.equal(cli.out.length, 0);
});

test("publicbody autocomplete hits the autocomplete endpoint", async () => {
  const cli = makeCli(() => jsonResponse(fx.autocomplete));
  const code = await run(["publicbody", "autocomplete", "umwelt"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/api/v1/publicbody/autocomplete/");
  assert.equal(url.searchParams.get("q"), "umwelt");
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestDetail));
  assert.equal(await run(["--timeout", "2147483647", "request", "get", "1"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  // Commander parse errors exit 1 in this CLI.
  const over = makeCli(() => jsonResponse(fx.requestDetail));
  assert.equal(await run(["--timeout", "2147483648", "request", "get", "1"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
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

// A blank filter/query/id ("" or whitespace, often an unset shell variable) used to
// be sent as an empty parameter or path segment, so the command ran unfiltered and
// exited 0. Each is now a parse-time usage error, before any request.
const blankCases: Array<{ input: string; argv: string[] }> = [
  { input: "--jurisdiction", argv: ["request", "list", "--jurisdiction", ""] },
  { input: "--jurisdiction (whitespace)", argv: ["request", "list", "--jurisdiction", "   "] },
  { input: "--law", argv: ["request", "list", "--law", ""] },
  { input: "--categories", argv: ["request", "list", "--categories", ""] },
  { input: "--classification", argv: ["request", "list", "--classification", ""] },
  { input: "--campaign", argv: ["request", "list", "--campaign", ""] },
  { input: "--public-body", argv: ["request", "list", "--public-body", ""] },
  { input: "--tags", argv: ["request", "list", "--tags", ""] },
  { input: "--reference", argv: ["request", "list", "--reference", ""] },
  { input: "--slug", argv: ["request", "list", "--slug", ""] },
  { input: "--created-after", argv: ["request", "list", "--created-after", ""] },
  { input: "--created-before", argv: ["request", "list", "--created-before", ""] },
  { input: "--project", argv: ["request", "list", "--project", ""] },
  { input: "--user", argv: ["request", "list", "--user", ""] },
  { input: "--follower", argv: ["request", "list", "--follower", ""] },
  { input: "--q", argv: ["request", "search", "--q", ""] },
  { input: "--category", argv: ["request", "search", "--category", ""] },
  { input: "--classification-id", argv: ["publicbody", "list", "--classification-id", ""] },
  { input: "--regions", argv: ["publicbody", "list", "--regions", ""] },
  { input: "--lnglat", argv: ["publicbody", "list", "--lnglat", ""] },
  { input: "--name", argv: ["category", "list", "--name", ""] },
  { input: "--parent", argv: ["category", "list", "--parent", ""] },
  { input: "--ancestor", argv: ["classification", "list", "--ancestor", ""] },
  { input: "--depth", argv: ["classification", "list", "--depth", ""] },
  { input: "--kind-detail", argv: ["georegion", "list", "--kind-detail", ""] },
  { input: "--level", argv: ["georegion", "list", "--level", ""] },
  { input: "--region-identifier", argv: ["georegion", "list", "--region-identifier", ""] },
  { input: "--id", argv: ["georegion", "list", "--id", ""] },
  { input: "--latlng", argv: ["georegion", "list", "--latlng", ""] },
  { input: "--request", argv: ["message", "list", "--request", ""] },
  { input: "--publicbody", argv: ["document", "list", "--publicbody", ""] },
  { input: "--foirequest", argv: ["document", "list", "--foirequest", ""] },
  { input: "--collection", argv: ["document", "list", "--collection", ""] },
  { input: "--portal", argv: ["document", "list", "--portal", ""] },
  { input: "--directory", argv: ["document", "list", "--directory", ""] },
  { input: "--tag", argv: ["document", "list", "--tag", ""] },
  { input: "--ids", argv: ["document", "list", "--ids", ""] },
  { input: "<id>", argv: ["request", "get", ""] },
  { input: "<id> (whitespace)", argv: ["law", "get", "  "] },
];

for (const { input, argv } of blankCases) {
  test(`a blank ${input} is rejected before any request (${argv.slice(0, 2).join(" ")})`, async () => {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    const code = await run(argv, cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
  });
}

// Exploratory test 2026-09-26, finding 1: a CSV body has no total_count / next, so
// a full page must say that it may not be the whole dataset.
test("a full CSV page notes on stderr that there may be more rows", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => `${i + 1},"Zeile\nmit Umbruch",resolved`);
  const body = `id,title,status\r\n${rows.join("\r\n")}\r\n`;
  const cli = makeCli(() => rawResponse(body, "text/csv"));
  const code = await run(["--output", "/tmp/p.csv", "document", "list", "--offset", "100", "--csv"], cli.deps);
  assert.equal(code, 0);
  assert.match(
    cli.err.join("\n"),
    /Note: the CSV holds one page, rows 101-150; there may be more\. .*--offset 150/,
  );
});

test("a CSV page shorter than --limit gets no paging note", async () => {
  const cli = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  assert.equal(await run(["publicbody", "search", "--q", "x", "--limit", "5", "--csv"], cli.deps), 0);
  assert.doesNotMatch(cli.err.join("\n"), /Note:/);
  const full = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  assert.equal(await run(["request", "search", "--q", "x", "--limit", "2", "--csv"], full.deps), 0);
  assert.match(full.err.join("\n"), /rows 1-2; there may be more/);
});

test("countCsvRows counts records outside quotes, minus the header", () => {
  assert.equal(countCsvRows(""), 0);
  assert.equal(countCsvRows("a,b\r\n"), 0);
  assert.equal(countCsvRows('a,b\r\n1,"x\r\ny ""q"""\r\n2,z'), 2);
  assert.equal(countCsvRows("a,b\n1,2\n2,3\n"), 2);
});

// Exploratory test 2026-09-26, finding 2: the search endpoint ignores `category`.
test("publicbody search --category is sent as categories; list keeps category", async () => {
  const search = makeCli(() => jsonResponse(fx.publicBodyList));
  assert.equal(await run(["publicbody", "search", "--q", "amt", "--category", "1"], search.deps), 0);
  const sq = new URL(search.mt.last().url).searchParams;
  assert.equal(sq.get("categories"), "1");
  assert.equal(sq.has("category"), false);

  const list = makeCli(() => jsonResponse(fx.publicBodyList));
  assert.equal(await run(["publicbody", "list", "--category", "1"], list.deps), 0);
  const lq = new URL(list.mt.last().url).searchParams;
  assert.equal(lq.get("category"), "1");
  assert.equal(lq.has("categories"), false);
});

// Exploratory test 2026-09-26, finding 3: get ids are numeric.
for (const id of [".", "..", "1.5", "0x10", "abc", " 1", "1e3"]) {
  test(`get ${JSON.stringify(id)} is a usage error before any request`, async () => {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    const code = await run(["request", "get", id], cli.deps);
    assert.equal(code, 1);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Expected a numeric id \(digits only\)\./);
  });
}

test("get with a numeric id requests the detail path", async () => {
  const cli = makeCli(() => jsonResponse({ id: 34126 }));
  assert.equal(await run(["publicbody", "get", "34126"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/api/v1/publicbody/34126/");
});

// Exploratory test 2026-09-26, finding 4: the API ignores an unparseable point.
const badPoints: Array<[string[], string, RegExp]> = [
  [["georegion", "list", "--latlng"], "abc", /Expected "lat,lng" as two decimal numbers/],
  [["georegion", "list", "--latlng"], "51.34;12.37", /Expected "lat,lng"/],
  [["georegion", "list", "--latlng"], "51.34, 12.37", /Expected "lat,lng"/],
  [["georegion", "list", "--latlng"], "120.1,51.3", /Latitude 120\.1 is out of range/],
  [["georegion", "list", "--latlng"], "51.3,181", /Longitude 181 is out of range/],
  [["publicbody", "list", "--lnglat"], "abc", /Expected "lng,lat" as two decimal numbers/],
  [["publicbody", "list", "--lnglat"], "12.37,91", /Latitude 91 is out of range .*lng,lat/],
];
for (const [argv, value, message] of badPoints) {
  test(`${argv.join(" ")} ${JSON.stringify(value)} is a usage error before any request`, async () => {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run([...argv, value], cli.deps), 1);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("well-formed --latlng / --lnglat points are sent unchanged", async () => {
  const geo = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["georegion", "list", "--latlng", "51.34,12.37"], geo.deps), 0);
  assert.equal(new URL(geo.mt.last().url).searchParams.get("latlng"), "51.34,12.37");
  const pb = makeCli(() => jsonResponse(fx.publicBodyList));
  assert.equal(await run(["publicbody", "list", "--lnglat", "-3,-45.5"], pb.deps), 0);
  assert.equal(new URL(pb.mt.last().url).searchParams.get("lnglat"), "-3,-45.5");
});

test("bidi controls in server data are escaped in the JSON output", async () => {
  const served = { ...fx.requestDetail, title: "a‮b⁦c" };
  const cli = makeCli(() => jsonResponse(served));
  assert.equal(await run(["--compact", "request", "get", "1"], cli.deps), 0);
  assert.match(cli.out.join(""), /a\\u202eb\\u2066c/);
  assert.deepEqual(JSON.parse(cli.out.join("")).title, served.title);
});

test("--max-retries above 10 is a usage error", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["--max-retries", "99999999999999", "request", "list"], cli.deps), 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Must be <= 10\./);
  const ok = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["--max-retries", "10", "request", "list"], ok.deps), 0);
});

// Exploratory test 2026-09-26, finding 9: deep nesting overflows the pretty printer.
test("a deeply nested response is a clean error, not 'Unexpected error'", async () => {
  const depth = 200_000;
  const deep = "[".repeat(depth) + "]".repeat(depth);
  const cli = makeCli(() => rawResponse(deep, "application/json"));
  assert.equal(await run(["request", "search", "--q", "deep"], cli.deps), 1);
  assert.match(cli.err.join("\n"), /^Error: The response is nested too deeply to pretty-print; try --compact\.$/);

  const compact = makeCli(() => rawResponse(deep, "application/json"));
  const code = await run(["--compact", "request", "search", "--q", "deep"], compact.deps);
  if (code === 0) assert.equal(compact.out.join(""), deep);
  else assert.match(compact.err.join("\n"), /nested too deeply to print\./);
});
