import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNonBlankParams,
  assertValid,
  isBlank,
  nonBlankProblem,
  type Problem,
} from "../src/client/validate.js";
import { FdsError, FdsValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { FragDenStaatClient } from "../src/client/client.js";

const notBlank: Problem<string> = (value) =>
  value.trim() === "" ? "Expected a non-empty value." : undefined;

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("q", "umwelt", notBlank), "umwelt");
});

test("assertValid throws FdsValidationError naming the input and the reason", () => {
  assert.throws(
    () => assertValid("q", " ", notBlank),
    (err: unknown) =>
      err instanceof FdsValidationError &&
      err instanceof FdsError &&
      err.name === "FdsValidationError" &&
      err.message === "Invalid q: Expected a non-empty value.",
  );
});

test("the validation layer is part of the library's public surface", () => {
  assert.equal(library.FdsValidationError, FdsValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("run() maps an FdsValidationError from an action to a usage error (exit 1)", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (t) => out.push(t), err: (t) => err.push(t), writeFile: () => {}, outBinary: () => {} },
    createClient: () =>
      ({
        jurisdictions: {
          list: async () => {
            throw new FdsValidationError("Invalid limit: Must be <= 50.");
          },
        },
      }) as unknown as FragDenStaatClient,
  };
  assert.equal(await run(["jurisdiction", "list"], deps), 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["Error: Invalid limit: Must be <= 50."]);
});

// --- blank values (PAT-9) ---------------------------------------------------------

test("isBlank is true only for an empty or whitespace-only string", () => {
  for (const v of ["", " ", "\t\n", " "]) assert.equal(isBlank(v), true, JSON.stringify(v));
  for (const v of ["a", " a ", 0, false, undefined, null]) assert.equal(isBlank(v), false, String(v));
});

test("nonBlankProblem names the rule for a blank string only", () => {
  assert.equal(nonBlankProblem(" "), "Expected a non-empty value.");
  assert.equal(nonBlankProblem("x"), undefined);
  assert.equal(nonBlankProblem(0), undefined);
});

test("assertNonBlankParams rejects a blank value, array element or key", () => {
  assert.throws(() => assertNonBlankParams({ q: " " }), {
    name: "FdsValidationError",
    message: "Invalid q: Expected a non-empty value.",
  });
  assert.throws(() => assertNonBlankParams({ status: ["resolved", ""] }), {
    message: "Invalid status: Expected a non-empty value.",
  });
  assert.throws(() => assertNonBlankParams({ " ": "x" }), {
    message: "Invalid parameter name: Expected a non-empty value.",
  });
  assert.doesNotThrow(() => assertNonBlankParams({ q: "x", limit: 5, a: undefined, b: null, c: false }));
});
