import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
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
