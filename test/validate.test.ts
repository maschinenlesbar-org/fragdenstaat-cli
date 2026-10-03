import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountProblem,
  assertNonBlankParams,
  idFilterProblem,
  normalizeIdFilter,
  baseUrlSpaceProblem,
  baseUrlProblem,
  validateBaseUrl,
  headerValueProblem,
  pointProblem,
  limitProblem,
  offsetProblem,
  validatePagination,
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
import { MAX_PAGE_SIZE } from "../src/client/params.js";
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

// --- pagination (PAT-11) ----------------------------------------------------------

test("MAX_PAGE_SIZE is the server's page cap and part of the public surface", () => {
  assert.equal(MAX_PAGE_SIZE, 50);
  assert.equal(library.MAX_PAGE_SIZE, 50);
});

test("limitProblem accepts an integer in 1..MAX_PAGE_SIZE", () => {
  assert.equal(limitProblem(1), undefined);
  assert.equal(limitProblem(50), undefined);
  assert.equal(limitProblem(0), "Must be >= 1.");
  assert.equal(limitProblem(-3), "Must be >= 1.");
  assert.equal(limitProblem(51), "Must be <= 50.");
  for (const v of [1.5, NaN, Infinity, 1e20, "5"]) assert.equal(limitProblem(v), "Expected an integer.", String(v));
});

test("offsetProblem accepts a non-negative safe integer", () => {
  assert.equal(offsetProblem(0), undefined);
  assert.equal(offsetProblem(10_000), undefined);
  for (const v of [-1, 1.5, NaN, Infinity, 1e20, "5"]) {
    assert.equal(offsetProblem(v), "Expected a non-negative integer.", String(v));
  }
});

test("validatePagination checks offset and limit when present", () => {
  assert.doesNotThrow(() => validatePagination({}));
  assert.doesNotThrow(() => validatePagination({ offset: 0, limit: 50 }));
  assert.throws(() => validatePagination({ limit: 100 }), {
    name: "FdsValidationError",
    message: "Invalid limit: Must be <= 50.",
  });
});

// --- points (PAT-17) ----------------------------------------------------------------

test("pointProblem checks shape and range in the given axis order", () => {
  const latlng = pointProblem("lat,lng");
  const lnglat = pointProblem("lng,lat");
  assert.equal(latlng("51.34,12.37"), undefined);
  assert.equal(latlng("-90,180"), undefined);
  assert.equal(lnglat("12.37,51.34"), undefined);
  assert.equal(latlng(""), "Expected a non-empty value.");
  for (const v of ["abc", " 51.34,12.37", "51.34, 12.37", "51.34", "1e2,3", "51,", 51.34]) {
    assert.equal(latlng(v), 'Expected "lat,lng" as two decimal numbers, e.g. 51.34,12.37.', String(v));
  }
  assert.equal(lnglat("x"), 'Expected "lng,lat" as two decimal numbers, e.g. 12.37,51.34.');
  assert.equal(latlng("120,50"), "Latitude 120 is out of range (-90..90); the order is lat,lng.");
  assert.equal(latlng("50,181"), "Longitude 181 is out of range (-180..180); the order is lat,lng.");
  assert.equal(lnglat("51.34,120"), "Latitude 120 is out of range (-90..90); the order is lng,lat.");
});

// --- header values (PAT-5) -----------------------------------------------------------

test("headerValueProblem accepts Latin-1 text with tabs", () => {
  for (const v of ["fragdenstaat-cli", "a\tb", "caf\u00e9", "\u00ff"]) {
    assert.equal(headerValueProblem(v), undefined, JSON.stringify(v));
  }
});

test("headerValueProblem rejects blank, control characters and code points above U+00FF", () => {
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem(" \t"), "Expected a non-empty value.");
  assert.equal(headerValueProblem(42), "Expected a non-empty value.");
  for (const v of ["a\r\nb", "a\nb", "a\u0000b", "a\u007fb"]) {
    assert.equal(headerValueProblem(v), "Value contains control characters.", JSON.stringify(v));
  }
  for (const v of ["agent\u2192", "\u20ac", "\u{1f600}"]) {
    assert.equal(headerValueProblem(v), "Value contains characters outside Latin-1 (above U+00FF).", v);
  }
});

// --- base URL whitespace (PAT-1) ----------------------------------------------------

test("baseUrlSpaceProblem rejects surrounding and inner whitespace or control characters", () => {
  assert.equal(baseUrlSpaceProblem("https://fragdenstaat.de"), undefined);
  assert.equal(baseUrlSpaceProblem("http://127.0.0.1:8080/base/"), undefined);
  for (const v of [" https://h", "https://h ", "https://h\n", "\thttps://h", "\u00a0https://h"]) {
    assert.equal(baseUrlSpaceProblem(v), "A base URL cannot have surrounding whitespace.", JSON.stringify(v));
  }
  for (const v of ["https://h/a b", "https://h/a\tb", "https://h/a\u0000b", "https://h/a\u007fb", "https://h/a\u2028b"]) {
    assert.equal(
      baseUrlSpaceProblem(v),
      "A base URL cannot contain whitespace or control characters.",
      JSON.stringify(v),
    );
  }
});

// --- base URL rules (PAT-1, PAT-2) --------------------------------------------------

test("baseUrlProblem accepts an http(s) URL and reports each malformed shape", () => {
  for (const v of ["https://fragdenstaat.de", "http://127.0.0.1:8080/base/", "https://u:p@h.example/fds"]) {
    assert.equal(baseUrlProblem(v), undefined, v);
  }
  assert.equal(baseUrlProblem(""), 'Invalid URL "".');
  assert.equal(baseUrlProblem("not a url"), "A base URL cannot contain whitespace or control characters.");
  assert.equal(baseUrlProblem("not-a-url"), 'Invalid URL "not-a-url".');
  assert.equal(baseUrlProblem(" https://h"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("ftp://h"), 'Unsupported protocol "ftp:" (use http or https).');
  assert.equal(baseUrlProblem("https://h/?x=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem("https://h/#f"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem(42), "Expected a URL string.");
  // userinfo never reaches the message, even when the value does not parse.
  assert.equal(baseUrlProblem("https://u:s3cret@[bad"), 'Invalid URL "https://***@[bad".');
});

test("validateBaseUrl strips trailing slashes and throws FdsValidationError", () => {
  assert.equal(validateBaseUrl("https://h.example///"), "https://h.example");
  assert.equal(validateBaseUrl("https://h.example/fds/"), "https://h.example/fds");
  assert.equal(validateBaseUrl(validateBaseUrl("https://h.example/")), "https://h.example");
  assert.throws(() => validateBaseUrl("ftp://h"), {
    name: "FdsValidationError",
    message: 'Invalid baseUrl: Unsupported protocol "ftp:" (use http or https).',
  });
  assert.throws(() => validateBaseUrl("https://h/ "), FdsValidationError);
});

// --- id and amount filters (PAT-16) -------------------------------------------------

test("idFilterProblem accepts a non-negative safe integer or a digit string", () => {
  for (const v of [0, 5, "0", "5", "007", String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(idFilterProblem(v), undefined, String(v));
  }
  for (const v of ["", " 5", "5 ", "-1", "+1", "1.5", "0x10", "abc", "99999999999999999999", -1, 1.5, NaN, Infinity, true]) {
    assert.equal(idFilterProblem(v), "Expected a non-negative integer.", String(v));
  }
});

test("normalizeIdFilter returns the number, idempotently, or throws FdsValidationError", () => {
  assert.equal(normalizeIdFilter("jurisdiction", "007"), 7);
  assert.equal(normalizeIdFilter("jurisdiction", 7), 7);
  assert.throws(() => normalizeIdFilter("mediator", "x1"), {
    name: "FdsValidationError",
    message: "Invalid mediator: Expected a non-negative integer.",
  });
});

test("amountProblem accepts a finite non-negative number", () => {
  for (const v of [0, 12.5, 1e6]) assert.equal(amountProblem(v), undefined, String(v));
  for (const v of [-5, -0.01, NaN, Infinity, "12", ""]) {
    assert.equal(amountProblem(v), "Expected a non-negative number.", String(v));
  }
});
