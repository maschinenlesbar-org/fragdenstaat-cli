// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { FdsValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";

/**
 * A validation rule: returns the reason `value` is invalid (one sentence, e.g.
 * `"Expected a non-empty value."`), or `undefined` when it is valid.
 */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Enforce a rule: throw {@link FdsValidationError} with the message
 * `Invalid <name>: <reason>` when `problem(value)` reports one, else return `value`
 * unchanged. Client methods that return a promise call it inside the async body,
 * so a rejected input rejects the promise (and sends no request) instead of
 * throwing synchronously.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new FdsValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** True for a string that is empty or only whitespace. */
export function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

/**
 * Rule: not a blank string. The API treats an empty parameter as no filter at all,
 * so a blank filter or query would silently return the whole unfiltered dataset
 * (or every autocomplete suggestion). Values that are not strings pass.
 */
export const nonBlankProblem: Problem<unknown> = (value) =>
  isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * Reject a query whose value (or array element) is a blank string, or which has a
 * blank parameter name; throws {@link FdsValidationError} naming the parameter.
 * `undefined` and `null` still mean "omitted". The engine runs this on every
 * request's query before building the URL.
 */
export function assertNonBlankParams(params: QueryParams): void {
  for (const [key, value] of Object.entries(params)) {
    assertValid("parameter name", key, nonBlankProblem);
    for (const v of Array.isArray(value) ? value : [value]) assertValid(key, v, nonBlankProblem);
  }
}
