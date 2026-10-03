import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNonBlankParams,
  booleanProblem,
  oneOfProblem,
  validateParams,
  assertValid,
  isBlank,
  nonBlankProblem,
  normalizeResourceId,
  resourceIdProblem,
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

// --- resource ids (PAT-10) --------------------------------------------------------

test("resourceIdProblem accepts a non-negative integer or a digit string", () => {
  for (const id of [0, 42, Number.MAX_SAFE_INTEGER, "0", "42", "007"]) {
    assert.equal(resourceIdProblem(id), undefined, String(id));
  }
});

test("resourceIdProblem rejects everything else, with its own message for a blank id", () => {
  assert.equal(resourceIdProblem(""), "Expected a non-empty value.");
  assert.equal(resourceIdProblem("  "), "Expected a non-empty value.");
  for (const id of ["search", " 1", "1.5", "-1", "+1", "1e3", "0x10", "١", 1.5, -1, NaN, Infinity, 2 ** 53, null]) {
    assert.equal(resourceIdProblem(id), "Expected a numeric id (digits only).", String(id));
  }
});

test("normalizeResourceId returns the path segment or throws FdsValidationError", () => {
  assert.equal(normalizeResourceId(42), "42");
  assert.equal(normalizeResourceId("42"), "42");
  assert.throws(() => normalizeResourceId("search"), {
    name: "FdsValidationError",
    message: "Invalid id: Expected a numeric id (digits only).",
  });
});

// --- enum and boolean filters (PAT-12) --------------------------------------------

test("oneOfProblem accepts only the listed values, case-sensitively", () => {
  const problem = oneOfProblem(["email", "post"]);
  assert.equal(problem("email"), undefined);
  for (const v of ["Email", "", "fax", 1, undefined]) {
    assert.equal(problem(v), "Allowed choices are email, post.", String(v));
  }
  // An inherited Object.prototype name is not a choice.
  assert.equal(problem("toString"), "Allowed choices are email, post.");
});

test("booleanProblem accepts only a boolean", () => {
  assert.equal(booleanProblem(true), undefined);
  assert.equal(booleanProblem(false), undefined);
  for (const v of ["true", "yes", 1, 0, ""]) {
    assert.equal(booleanProblem(v), "Expected a boolean (true or false).", String(v));
  }
});

test("validateParams checks only the ruled fields that are present", () => {
  const rules = { kind: oneOfProblem(["email"]), is_draft: booleanProblem };
  assert.doesNotThrow(() => validateParams({ kind: "email", other: "x" }, rules));
  assert.doesNotThrow(() => validateParams({ kind: undefined, is_draft: null }, rules));
  assert.throws(() => validateParams({ is_draft: "no" }, rules), {
    name: "FdsValidationError",
    message: "Invalid is_draft: Expected a boolean (true or false).",
  });
});
