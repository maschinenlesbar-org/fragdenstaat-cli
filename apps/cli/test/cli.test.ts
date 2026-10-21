import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { FragDenStaatClient } from "@maschinenlesbar.org/fragdenstaat-client/internal/client";
import { FdsError, credentialsIn } from "@maschinenlesbar.org/fragdenstaat-client/internal/errors";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/fragdenstaat-client/internal/http";
import { makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";
import { countCsvRows, renderJson } from "../src/cli/shared.js";
import * as fx from "@maschinenlesbar.org/fragdenstaat-client/test/fixtures";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputError, defaultIO } from "../src/cli/io.js";

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
      outputState: (p) => (p.endsWith("/") ? "directory" : files.has(p) ? "exists" : "missing"),
      outBinary: (d) => void out.push(d.toString("utf8")),
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
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[fragdenstaat\.output\] Wrote \d+ bytes to stdout \(Content-Type: text\/csv/);
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
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[fragdenstaat\.output\] Wrote \d+ bytes to \/tmp\/out\.csv/);
});

test("an -o path with a line break, ESC or a bidi control stays inside one escaped record", async () => {
  const path = "/tmp/f\n2026-10-09T00:00:00.000Z ERROR [fragdenstaat.api] HTTP 500 forged\u001b[31m\u202e.json";
  for (const format of ["text", "jsonl"]) {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    const code = await run(["--log-format", format, "-o", path, "request", "list"], cli.deps);
    assert.equal(code, 0);
    assert.ok(cli.files.has(path));
    assert.equal(cli.err.length, 1, cli.err.join("\n"));
    const line = cli.err[0] as string;
    assert.ok(!/[\n\u001b\u202e]/.test(line), JSON.stringify(line));
    if (format === "jsonl") assert.match((JSON.parse(line) as { msg: string }).msg, /^Wrote \d+ bytes to \/tmp\/f\n2026/);
    else assert.match(untimed(line), /^INFO  \[fragdenstaat\.output\] Wrote \d+ bytes to \/tmp\/f\\n2026-10-09T00:00:00\.000Z ERROR \[fragdenstaat\.api\] HTTP 500 forged\\u001b\[31m\\u202e\.json/);
  }
});

test("own notes quote a server or user value at most 500 characters long (L3)", async () => {
  const csv = makeCli(() => rawResponse(fx.csvBody, `text/csv; x=${"z".repeat(10_000)}`));
  assert.equal(await run(["-o", "/tmp/out.csv", "request", "list", "--csv"], csv.deps), 0);
  const note = csv.err.join("\n");
  assert.match(note, /\(Content-Type: text\/csv; x=z+…\)$/);
  assert.ok(note.length < 700, `${note.length}`);

  const empty = makeCli(() => jsonResponse({ meta: { total_count: 0, limit: 50, offset: 0, next: null, previous: null }, objects: [] }));
  assert.equal(await run(["--compact", "request", "list", "--tags", "t".repeat(10_000)], empty.deps), 0);
  const hint = empty.err.join("\n");
  assert.match(hint, /--tags "t+"… takes one exact tag name/);
  assert.ok(hint.length < 800, `${hint.length}`);

  const bool = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["request", "list", "--is-foi", "b".repeat(10_000)], bool.deps), 1);
  assert.ok(bool.err.join("\n").length < 800, `${bool.err.join("\n").length}`);
});

// FDS-02 — -o must not silently clobber an existing file; --force opts back in.
test("--output refuses to overwrite an existing file without --force", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  cli.files.set("/tmp/exists.json", Buffer.from("keep me"));
  const code = await run(["--output", "/tmp/exists.json", "request", "list", "--limit", "1"], cli.deps);
  assert.notEqual(code, 0);
  // The existing file is untouched, and the message points at --force.
  assert.equal(cli.files.get("/tmp/exists.json")?.toString("utf8"), "keep me");
  assert.equal(untimed(cli.err.join("\n")), 'ERROR [fragdenstaat.output] Refusing to overwrite existing file "/tmp/exists.json" (use --force).');
  // Refused before any request (kit K7): it used to be refused only after the download.
  assert.equal(cli.mt.calls.length, 0);
});

test("-o is checked before any request: --force without -o, a directory, an existing file (kit K7)", async () => {
  for (const [argv, message] of [
    [["--force", "request", "list"], "ERROR [fragdenstaat.cli] --force needs --output (it only allows overwriting the -o file)."],
    [["-o", "/tmp/dir/", "request", "list"], 'ERROR [fragdenstaat.output] "/tmp/dir/" is a directory; give a file path to --output.'],
    [["-o", "/tmp/dir/", "--force", "request", "list", "--csv"], 'ERROR [fragdenstaat.output] "/tmp/dir/" is a directory; give a file path to --output.'],
    [["-o", "/tmp/exists.json", "request", "search", "--q", "x"], 'ERROR [fragdenstaat.output] Refusing to overwrite existing file "/tmp/exists.json" (use --force).'],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    cli.files.set("/tmp/exists.json", Buffer.from("keep me"));
    assert.equal(await run([...argv], cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
    assert.equal(untimed(cli.err.join("\n")), message, argv.join(" "));
  }
  // `-o -` is stdout, so --force with it is allowed.
  const dash = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["-o", "-", "--force", "request", "list"], dash.deps), 0, dash.err.join("\n"));
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of the output area", async () => {
  // The write-time refusal comes after the request was made: a write failure (an OutputError,
  // exit 1), not a usage error. JSON and a CSV download, on real files.
  const dir = mkdtempSync(join(tmpdir(), "fds-race-"));
  try {
    for (const [argv, answer] of [
      [["request", "list"], () => jsonResponse(fx.requestList)],
      [["request", "list", "--csv"], () => rawResponse(fx.csvBody, "text/csv")],
    ] as const) {
      const path = join(dir, "race.out");
      const out: string[] = [];
      const err: string[] = [];
      const mt = makeMockTransport(() => {
        writeFileSync(path, "theirs");
        return answer();
      });
      const deps: CliDeps = {
        io: { ...defaultIO, out: (s) => out.push(s), err: (s) => err.push(s) },
        createClient: (opts) => new FragDenStaatClient({ ...opts, transport: mt.transport }),
      };
      assert.equal(await run(["-o", path, ...argv], deps), 1, argv.join(" "));
      assert.equal(mt.calls.length, 1, argv.join(" "));
      assert.equal(readFileSync(path, "utf8"), "theirs", argv.join(" "));
      assert.deepEqual(err.map(untimed), [`ERROR [fragdenstaat.output] Refusing to overwrite existing file "${path}" (use --force).`], argv.join(" "));
      assert.deepEqual(out, [], argv.join(" "));
      assert.deepEqual(readdirSync(dir), ["race.out"], argv.join(" "));
      rmSync(path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    untimed(cli.err.join("\n")),
    /^INFO  \[fragdenstaat\.api\] the CSV holds one page, rows 101-150; there may be more\. .*--offset 150/m,
  );
});

test("a CSV page shorter than --limit gets no paging note", async () => {
  const cli = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  assert.equal(await run(["publicbody", "search", "--q", "x", "--limit", "5", "--csv"], cli.deps), 0);
  assert.doesNotMatch(cli.err.join("\n"), /the CSV holds one page/);
  const full = makeCli(() => rawResponse(fx.csvBody, "text/csv"));
  assert.equal(await run(["request", "search", "--q", "x", "--limit", "2", "--csv"], full.deps), 0);
  assert.match(full.err.join("\n"), /rows 1-2; there may be more/);
});

test("countCsvRows counts records outside quotes, minus the header", () => {
  assert.equal(countCsvRows(""), 0);
  assert.equal(countCsvRows("a,b\r\n"), 0);
  assert.equal(countCsvRows('a,b\r\n1,"x\r\ny ""q"""\r\n2,z'), 2);
  assert.equal(countCsvRows("a,b\n1,2\n2,3\n"), 2);
  // The bytes of a page count the same, without decoding it (a page too large for one string).
  assert.equal(countCsvRows(Buffer.from('a,b\r\n1,"x\r\ny ""q"""\r\n2,z')), 2);
  assert.equal(countCsvRows(Buffer.from("a,b\n1,M\xfcller\n2,3\n", "latin1")), 2);
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
test("an answer nested too deeply is a clean error of the output area; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed. Inside a valid envelope: a bare deep array is the wrong shape (P9).
  const depth = 200_000;
  const deep = `{"meta":{"total_count":1},"objects":[${"[".repeat(depth) + "]".repeat(depth)}]}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(deep));
  } catch {
    compactPrints = false;
  }
  const cli = makeCli(() => rawResponse(deep, "application/json"));
  assert.equal(await run(["request", "search", "--q", "deep"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.equal(
    untimed(cli.err.join("\n")),
    `ERROR [fragdenstaat.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  const compact = makeCli(() => rawResponse(deep, "application/json"));
  assert.equal(await run(["--compact", "request", "search", "--q", "deep"], compact.deps), compactPrints ? 0 : 1);
  if (compactPrints) assert.equal(compact.out.join(""), deep);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [fragdenstaat.output] The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(() => jsonResponse({}));
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: 1 }), (err: Error) =>
    err instanceof OutputError && /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

// Exploratory test 2026-09-26, finding 10: a query/fragment swallows the path.
for (const [value, message] of [
  ["http://127.0.0.1:18115/?x=1", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
  ["http://127.0.0.1:18115/#frag", /cannot have a query \(\?\) or fragment/],
  [" https://fragdenstaat.de", /A base URL cannot have surrounding whitespace\./],
] as const) {
  test(`--base-url ${JSON.stringify(value)} is a usage error`, async () => {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run(["--base-url", value, "request", "list"], cli.deps), 1);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  });
}

test("--base-url with a path prefix still works", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["--base-url", "https://mirror.example/fds/", "request", "list"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/fds/api/v1/request/");
});

// Exploratory test 2026-09-26, finding 11: userinfo must not reach stderr.
test("a --base-url password is redacted in API error messages", async () => {
  const cli = makeCli(() => jsonResponse(fx.notFound, 404));
  const code = await run(["--base-url", "http://u:s3cret@127.0.0.1:18115", "request", "get", "9"], cli.deps);
  assert.equal(code, 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /s3cret/);
  assert.match(err, /HTTP 404 for GET http:\/\/\*\*\*@127\.0\.0\.1:18115\/api\/v1\/request\/9\//);
  // The request itself still carries the userinfo (Basic auth for a protected mirror).
  assert.match(cli.mt.last().url, /u:s3cret@/);
});

// Exploratory test 2026-09-26, finding 12: a non-Latin-1 User-Agent.
test("a non-Latin-1 --user-agent is a usage error; Latin-1 and tab pass", async () => {
  const cli = makeCli(() => jsonResponse(fx.jurisdictionList));
  assert.equal(await run(["--user-agent", "agent☃", "jurisdiction", "list"], cli.deps), 1);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Value contains characters outside Latin-1 \(above U\+00FF\)\./);
  assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);

  const ok = makeCli(() => jsonResponse(fx.jurisdictionList));
  assert.equal(await run(["--user-agent", "agentü\tx", "jurisdiction", "list"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "agentü\tx");
});

test("a directory error from writeFile is printed as is, without the --force hint", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  cli.deps.io.writeFile = () => {
    throw new FdsError('"/tmp" is a directory; give a file path to --output.');
  };
  assert.equal(await run(["-o", "/tmp", "request", "list"], cli.deps), 1);
  assert.equal(untimed(cli.err.join("\n")), 'ERROR [fragdenstaat.output] "/tmp" is a directory; give a file path to --output.');
});

// Exploratory test 2026-09-26, finding 17: a repeated filter kept only its last value.
const repeated: string[][] = [
  ["request", "list", "--status", "resolved", "--status", "asleep"],
  ["request", "list", "--is-foi", "true", "--is-foi", "false"],
  ["request", "list", "--checked", "--checked", "false"],
  ["request", "list", "--jurisdiction", "1", "--jurisdiction", "2"],
  ["request", "list", "--costs-min", "1", "--costs-min", "2"],
  ["request", "list", "--limit", "5", "--limit", "6"],
  ["request", "search", "--q", "a", "--q", "b"],
  ["publicbody", "search", "--category", "1", "--category", "2"],
  ["law", "list", "--jurisdiction", "1", "--jurisdiction", "2"],
  ["message", "list", "--kind", "email", "--kind", "post"],
  ["georegion", "list", "--latlng", "51,12", "--latlng", "52,13"],
  ["document", "list", "--offset", "0", "--offset", "50"],
  // Bug 01-1 of the 2026-10-21 sweep (T11): a bare repeat after a value turned `false` into `true`.
  ["request", "list", "--is-foi", "false", "--is-foi"],
  ["request", "list", "--is-foi", "--is-foi"],
  ["request", "list", "--checked", "false", "--checked"],
  ["request", "list", "--has-same", "false", "--has-same"],
  ["message", "list", "--is-response", "false", "--is-response"],
  ["category", "list", "--is-topic", "false", "--is-topic"],
  ["law", "list", "--meta", "false", "--meta"],
];
for (const argv of repeated) {
  test(`repeating a single-valued option is a usage error: ${argv.slice(2).join(" ")}`, async () => {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run(argv, cli.deps), 1);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Given more than once; this option takes a single value\./);
  });
}

test("repeating a global value option is a usage error, before any request (kit K5)", async () => {
  // commander keeps the last value silently: `--timeout 1000 --timeout 0` switched the timeout
  // off, `--base-url a --base-url b` asked b, with exit 0.
  for (const argv of [
    ["--timeout", "1000", "--timeout", "0", "request", "list"],
    ["--timeout=1000", "request", "list", "--timeout", "1000"],
    ["--base-url", "https://fragdenstaat.de", "--base-url", "https://fragdenstaat.de", "request", "list"],
    ["--log-format", "jsonl", "--log-format", "text", "request", "list"],
    ["--user-agent", "a", "--user-agent", "b", "request", "list"],
    ["--max-retries", "1", "--max-retries", "2", "request", "list"],
    ["--max-response-bytes", "10", "--max-response-bytes", "0", "request", "list"],
    ["-o", "-", "--output", "-", "request", "list"],
  ]) {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
    assert.match(cli.err.join("\n"), /Given more than once; this option takes a single value\./, argv.join(" "));
  }
  // Given once, the default --base-url counts as not given; flags may repeat.
  const once = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["--base-url", "https://fragdenstaat.de", "request", "list"], once.deps), 0, once.err.join("\n"));
  const flags = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["--compact", "--compact", "request", "list"], flags.deps), 0, flags.err.join("\n"));
});

test("repeated --ids accumulate into one comma-separated value", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["document", "list", "--ids", "1,2", "--ids", "3"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("ids"), "1,2,3");
});

test("choice options still reject an invalid value and list the choices in help", async () => {
  const cli = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["message", "list", "--kind", "pigeon"], cli.deps), 1);
  assert.match(cli.err.join("\n"), /Allowed choices are email/);
  const help = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["message", "list", "--help"], help.deps), 0);
  assert.match(help.out.join("\n"), /choices:\s+"email"/);
  const ok = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["message", "list", "--kind", "email", "--is-response"], ok.deps), 0);
  assert.equal(new URL(ok.mt.last().url).searchParams.get("kind"), "email");
  assert.equal(new URL(ok.mt.last().url).searchParams.get("is_response"), "true");
});

// Exploratory test 2026-09-26, finding 18: autocomplete pages like a list.
for (const argv of [
  ["publicbody", "autocomplete", "Amt"],
  ["law", "autocomplete", "Umwelt"],
  ["category", "autocomplete", "Digi"],
  ["georegion", "autocomplete", "Leip"],
  ["request", "tags", "lob"],
]) {
  test(`${argv.slice(0, 2).join(" ")} takes --offset/--limit`, async () => {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run([...argv, "--offset", "50", "--limit", "5"], cli.deps), 0);
    const q = new URL(cli.mt.last().url).searchParams;
    assert.equal(q.get("q"), argv[2]);
    assert.equal(q.get("offset"), "50");
    assert.equal(q.get("limit"), "5");
    const bad = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run([...argv, "--limit", "51"], bad.deps), 1);
    assert.equal(bad.mt.calls.length, 0);
  });
}

// Exploratory test 2026-10-05, result 03 bug 3: wrong-shape 200s exited 0.
test("a 200 with the wrong shape exits 1; an HTML 'CSV' writes no -o file", async () => {
  for (const body of [{ detail: "Wartung" }, null]) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["request", "list"], cli.deps), 1, JSON.stringify(body));
    assert.equal(cli.out.length, 0);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[fragdenstaat\.api\] GET https:\/\/fragdenstaat\.de\/api\/v1\/request\/: unexpected response shape \(HTTP 200\)/);
  }
  const arr = makeCli(() => jsonResponse([1, 2]));
  assert.equal(await run(["request", "get", "5"], arr.deps), 1);
  const html = makeCli(() => rawResponse("<html>Wartung</html>", "text/html"));
  assert.equal(await run(["-o", "requests.csv", "request", "list", "--csv"], html.deps), 1);
  assert.equal(html.files.size, 0);
  assert.match(html.err.join("\n"), /expected text\/csv, got an HTML page/);
});

test("an empty name-filtered request list notes the exact-name rule as an INFO record of fragdenstaat.api", async () => {
  const cli = makeCli(() => jsonResponse({ meta: { total_count: 0, limit: 50, offset: 0, next: null, previous: null }, objects: [] }));
  assert.equal(await run(["--compact", "request", "list", "--categories", "umwelt"], cli.deps), 0);
  assert.deepEqual(cli.err.map(untimed), [
    'INFO  [fragdenstaat.api] no request matched. Name filters match exactly and case-sensitively: --categories "umwelt" takes the exact category name, e.g. "Umwelt" (category list --q).',
  ]);
});

test("an a:b@c argument (a --tags text, an -o path) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse({ meta: { total_count: 0, limit: 50, offset: 0, next: null, previous: null }, objects: [], note: "a:b@c" }));
  assert.equal(await run(["--compact", "request", "list", "--tags", "a:b@c"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"note":"a:b@c"/);
  assert.match(cli.err.join("\n"), /--tags "a:b@c" takes/);
  const file = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["-o", "run:2026-10-09@x.json", "request", "list"], file.deps), 0);
  assert.match(untimed(file.err.join("\n")), /^INFO  \[fragdenstaat\.output\] Wrote \d+ bytes to run:2026-10-09@x\.json$/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("a group without its subcommand, and an unknown help topic, log an ERROR before the help (L5)", async () => {
  for (const [argv, error] of [
    [["request"], /^ERROR \[fragdenstaat\.cli\] missing command: `fragdenstaat request <subcommand>`$/],
    [[], /^ERROR \[fragdenstaat\.cli\] missing command: `fragdenstaat <subcommand>`$/],
    [["help", "nope"], /^ERROR \[fragdenstaat\.cli\] /],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 1, JSON.stringify(argv));
    const records = cli.err.map(untimed);
    assert.match(records[0] ?? "", error, records.join("\n"));
    assert.ok(records.length > 2 && records.slice(1).every((line) => line.startsWith("INFO  [fragdenstaat.cli] ")), records.join("\n"));
  }
});

test("an unknown option's (Did you mean …?) hint is part of its ERROR record (L5)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["publicbody", "list", "--categories", "Umwelt"], cli.deps), 1);
  assert.equal(untimed(cli.err[0] ?? ""), "ERROR [fragdenstaat.cli] unknown option '--categories' (Did you mean --category?)");
});

test("a repeated --log-format is a usage error, logged in the last one (L6, kit K5)", async () => {
  for (const [argv, jsonl] of [
    [["--log-format", "jsonl", "--log-format", "text", "request", "get", "1"], false],
    [["--log-format", "text", "--log-format", "jsonl", "request", "get", "1"], true],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ detail: "Nicht gefunden." }, 404));
    assert.equal(await run([...argv], cli.deps), 1, JSON.stringify(argv));
    assert.equal(cli.mt.calls.length, 0);
    const first = cli.err[0] ?? "";
    if (jsonl) assert.equal((JSON.parse(first) as Record<string, unknown>)["topic"], "fragdenstaat.cli", first);
    else assert.match(untimed(first), /^ERROR \[fragdenstaat\.cli\] .*Given more than once/);
  }
});

test("an option's value that looks like --log-format sets no format, in a parse error too (B03-1, L6)", async () => {
  // commander takes "--log-format" as the User-Agent and then fails on the command "jsonl".
  const agent = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--user-agent", "--log-format", "jsonl", "request", "get", "1"], agent.deps), 1);
  assert.match(untimed(agent.err[0] ?? ""), /^ERROR \[fragdenstaat\.cli\] unknown command 'jsonl'/, agent.err.join("\n"));
  // -o refuses it as the next option (T13): a usage error, in text.
  const output = makeCli(() => jsonResponse({}));
  assert.equal(await run(["-o", "--log-format", "jsonl", "request", "get", "1"], output.deps), 1);
  assert.match(untimed(output.err[0] ?? ""), /^ERROR \[fragdenstaat\.cli\] .*looks like a missing value/, output.err.join("\n"));
  assert.equal(output.files.size, 0);
  // commander takes "--log-format=jsonl" as the User-Agent and sends it: the log stays text.
  const ua = makeCli(() => jsonResponse({ detail: "Nicht gefunden." }, 404));
  assert.equal(await run(["--user-agent", "--log-format=jsonl", "request", "get", "1"], ua.deps), 4);
  assert.equal(ua.mt.last().headers?.["User-Agent"], "--log-format=jsonl");
  assert.match(untimed(ua.err[0] ?? ""), /^ERROR \[fragdenstaat\.api\] /);
});

test("every -o failure is an ERROR record of fragdenstaat.output, exit 1 (B04-1, L8)", async () => {
  for (const argv of [["-o", "out.json", "request", "list"], ["-o", "out.csv", "request", "list", "--csv"]]) {
    for (const thrown of [new Error("ENOENT: no such file or directory, open 'out.json'"), new Error("EACCES: permission denied, open 'out.json'"), new FdsError('"out" is a directory; give a file path to --output.')]) {
      const cli = makeCli(() => (argv.includes("--csv") ? rawResponse(fx.csvBody, "text/csv") : jsonResponse(fx.requestList)));
      cli.deps.io.writeFile = () => {
        throw thrown;
      };
      assert.equal(await run(argv, cli.deps), 1);
      assert.match(untimed(cli.err.join("\n")), /^ERROR \[fragdenstaat\.output\] /);
      assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    }
  }
});

test("a CSV to stdout logs \"Wrote N bytes to stdout\" and the page note only once the write has succeeded (B04-2)", async () => {
  const fullPage = `id,title\n${Array.from({ length: 50 }, (_, i) => `${i},t${i}`).join("\n")}\n`;
  // The write fails (EBADF: stdout opened read-only): no success note, no page note; handleOutputErrors reports the failure.
  const failed = makeCli(() => rawResponse(fullPage, "text/csv"));
  failed.deps.io.outBinary = async () => false;
  assert.equal(await run(["request", "list", "--csv"], failed.deps), 0);
  assert.deepEqual(failed.err, []);

  // The write completes later: the notes come after it, still within the run.
  const slow = makeCli(() => rawResponse(fullPage, "text/csv"));
  const order: string[] = [];
  slow.deps.io.outBinary = (data) =>
    new Promise<boolean>((resolve) =>
      setImmediate(() => {
        order.push(`wrote ${data.length}`);
        resolve(true);
      }),
    );
  slow.deps.io.err = (line) => order.push(untimed(line));
  assert.equal(await run(["request", "list", "--csv"], slow.deps), 0);
  assert.equal(order.length, 3, order.join("\n"));
  assert.match(order[0] ?? "", /^wrote \d+$/);
  assert.match(order[1] ?? "", /^INFO  \[fragdenstaat\.output\] Wrote \d+ bytes to stdout \(Content-Type: text\/csv\)$/);
  assert.match(order[2] ?? "", /^INFO  \[fragdenstaat\.api\] the CSV holds one page/);
});

test("a malformed answer to a CSV page is an ERROR record of fragdenstaat.api too (B01-3, L9)", async () => {
  const cli = makeCli(() => rawResponse("<!doctype html><html>Wartung</html>", "text/html"));
  assert.equal(await run(["-o", "/tmp/out.csv", "request", "list", "--csv"], cli.deps), 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[fragdenstaat\.api\] GET https:\/\/fragdenstaat\.de\/api\/v1\/request\/\?format=csv: unexpected response \(HTTP 200\)/);
  assert.equal(cli.files.size, 0);
});

test("an empty name-filtered request list --csv notes the exact-name rule too (B04-3)", async () => {
  // A header-only CSV: the CSV export's form of "no request matched".
  const empty = makeCli(() => rawResponse("id,title\r\n", "text/csv"));
  assert.equal(await run(["request", "list", "--tags", "Videoueberwachung", "--csv", "-o", "requests.csv"], empty.deps), 0);
  assert.deepEqual(empty.err.map(untimed), [
    "INFO  [fragdenstaat.output] Wrote 10 bytes to requests.csv (Content-Type: text/csv)",
    'INFO  [fragdenstaat.api] no request matched. Name filters match exactly and case-sensitively: --tags "Videoueberwachung" takes one exact tag name (request tags <text>).',
  ]);
  // No note without a name filter, for rows, or past the first page (the total may be more than 0).
  for (const [argv, body] of [
    [["request", "list", "--csv"], "id,title\r\n"],
    [["request", "list", "--tags", "Umwelt", "--csv"], "id,title\r\n1,a\r\n"],
    [["request", "list", "--tags", "Umwelt", "--csv", "--offset", "50"], "id,title\r\n"],
  ] as const) {
    const cli = makeCli(() => rawResponse(body, "text/csv"));
    assert.equal(await run([...argv], cli.deps), 0);
    assert.ok(cli.err.every((line) => !line.includes("no request matched")), cli.err.join("\n"));
  }
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first;  is left without its value.
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["request", "list", "--tags", "--log-format", "jsonl"], cli.deps);
  assert.notEqual(code, 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, / <[a-z]+>' argument missing/);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise (kit K4)", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(() => jsonResponse(fx.requestList));
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: 1, text: huge });
  renderJson(deps, { compact: true }, { id: 1, x: [[["Antrag"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: 1 });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

// Exploratory test 2026-10-21, bug 02-2: a Latin-1 CSV on stdout became U+FFFD (decoded as UTF-8).
test("--csv on stdout is decoded by its declared charset; bytes that don't fit become U+FFFD with a WARN (D2)", async () => {
  const latin1 = makeCli(() => rawResponse(Buffer.from("id,name\n1,M\xfcller\n", "latin1"), "text/csv; charset=iso-8859-1"));
  assert.equal(await run(["request", "list", "--csv"], latin1.deps), 0);
  assert.equal(latin1.out.join(""), "id,name\n1,Müller\n");
  assert.doesNotMatch(untimed(latin1.err.join("\n")), /WARN/);
  // The file keeps the server's bytes.
  const file = makeCli(() => rawResponse(Buffer.from("id,name\n1,M\xfcller\n", "latin1"), "text/csv; charset=iso-8859-1"));
  assert.equal(await run(["-o", "/tmp/l1.csv", "request", "list", "--csv"], file.deps), 0);
  assert.deepEqual(file.files.get("/tmp/l1.csv"), Buffer.from("id,name\n1,M\xfcller\n", "latin1"));
  // Invalid UTF-8: replaced, and said so, naming the request; never silent, never fatal.
  const bad = makeCli(() => rawResponse(Buffer.concat([Buffer.from("id,name\n1,M"), Buffer.from([0xfc]), Buffer.from("ller\n")]), "text/csv"));
  assert.equal(await run(["request", "list", "--csv"], bad.deps), 0);
  assert.equal(bad.out.join(""), "id,name\n1,M\ufffdller\n");
  assert.match(untimed(bad.err.join("\n")), /^WARN  \[fragdenstaat\.api\] GET https:\/\/fragdenstaat\.de\/api\/v1\/request\/\?format=csv: 1 character of the answer was not valid text \(invalid bytes or a lone surrogate\) and replaced with U\+FFFD\.$/m);
});

test("an answer with a lone surrogate or invalid bytes prints well-formed, with a WARN record of fragdenstaat.api (D2)", async () => {
  const cli = makeCli(() => rawResponse('{"id":1,"title":"a\\ud800b"}', "application/json"));
  assert.equal(await run(["--compact", "request", "get", "1"], cli.deps), 0);
  assert.equal(cli.out.join(""), '{"id":1,"title":"a\ufffdb"}');
  assert.match(untimed(cli.err.join("\n")), /^WARN  \[fragdenstaat\.api\] GET https:\/\/fragdenstaat\.de\/api\/v1\/request\/1\/: 1 character of the answer was not valid text/);
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli(() => jsonResponse({}));
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

// T13 (bundeswahlleiterin-cli 6d3ebbe): `-o --compact` wrote a file named "--compact" with exit 0.
test("-o refuses the next option as its file name, before any request; ./-name writes a dash-leading file (T13)", async () => {
  for (const argv of [["request", "list", "-o", "--compact"], ["--output=-v", "request", "list"], ["-o", "--force", "request", "list"]]) {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, argv.join(" "));
    assert.equal(cli.files.size, 0, argv.join(" "));
    const err = untimed(cli.err.join("\n"));
    assert.match(err, /^ERROR \[fragdenstaat\.cli\] .*looks like a missing value — "-[-a-z]+" is the next option/, argv.join(" "));
    assert.match(err, /\.\/-name/, argv.join(" "));
  }
  const cli = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["-o", "./-v.json", "request", "list"], cli.deps), 0);
  assert.deepEqual([...cli.files.keys()], ["./-v.json"]);
});

test("commander's echo of a refused value shows an invisible or format character escaped, never raw (D10)", async () => {
  const zwsp = String.fromCharCode(0x200b);
  const shy = String.fromCharCode(0x00ad);
  for (const argv of [["request", "list", "--limit", `1${zwsp}`], ["request", "list", "--status", `re${shy}solved`], ["request", "get", `1${zwsp}`]]) {
    const cli = makeCli(() => jsonResponse(fx.requestList));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    const err = cli.err.join("\n");
    assert.ok(!err.includes(zwsp) && !err.includes(shy), err);
    assert.match(err, /\\u200b|\\u00ad/, err);
  }
  // A value of a CLI-only check is quoted the same way.
  const bool = makeCli(() => jsonResponse(fx.requestList));
  assert.equal(await run(["request", "list", "--is-foi", `tr${zwsp}ue`], bool.deps), 1);
  assert.match(untimed(bool.err.join("\n")), /got "tr\\u200bue"/);
});

// Exploratory test 2026-10-21, bug 02-1: bidi controls in a CSV page reached the terminal raw.
test("--csv on stdout writes bidi controls as visible escapes; the -o file keeps them (D10)", async () => {
  const bidi = [0x202e, 0x202c, 0x2066, 0x2069, 0x061c, 0x200f].map((c) => String.fromCharCode(c));
  const body = `id,title\n1,safe ${bidi.join("x")}.exe\n`;
  const cli = makeCli(() => rawResponse(body, "text/csv"));
  assert.equal(await run(["request", "list", "--csv"], cli.deps), 0);
  const out = cli.out.join("");
  for (const ch of bidi) assert.ok(!out.includes(ch), `U+${ch.charCodeAt(0).toString(16)} printed raw`);
  assert.equal(out, "id,title\n1,safe \\u202ex\\u202cx\\u2066x\\u2069x\\u061cx\\u200f.exe\n");
  const file = makeCli(() => rawResponse(body, "text/csv"));
  assert.equal(await run(["-o", "/tmp/b.csv", "request", "list", "--csv"], file.deps), 0);
  assert.equal(file.files.get("/tmp/b.csv")?.toString("utf8"), body);
});

// Exploratory test 2026-10-21, bug 01-2: the note quoted " Mu\u0308ller " as typed, not the name sent.
test("the empty-result note quotes a name filter as it was sent: trimmed and in NFC", async () => {
  const empty = { meta: { limit: 50, next: null, offset: 0, previous: null, total_count: 0 }, objects: [] };
  const cli = makeCli(() => jsonResponse(empty));
  assert.equal(await run(["--compact", "request", "list", "--tags", " Mu\u0308ller "], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("tags"), "M\u00fcller");
  const note = untimed(cli.err.join("\n"));
  assert.match(note, /--tags "M\u00fcller" takes one exact tag name/);
  assert.ok(!note.includes("\u0308") && !note.includes(" Mu"), note);
});
