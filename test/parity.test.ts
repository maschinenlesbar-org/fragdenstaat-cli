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
