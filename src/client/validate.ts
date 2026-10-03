// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { FdsValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import { MAX_PAGE_SIZE, type Pagination } from "./params.js";

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

/**
 * Rule for a resource id in a detail path (`get(id)`): every wrapped detail
 * endpoint takes an integer id, so a number must be a non-negative safe integer and
 * a string a run of ASCII digits. Anything else would re-target the request: `"search"`
 * or `"autocomplete"` reach the list sub-endpoints and return a list envelope as if
 * it were a detail object, and `"."`/`".."` resolve to the list or the API root.
 */
export const resourceIdProblem: Problem<unknown> = (id) => {
  if (isBlank(id)) return "Expected a non-empty value.";
  const ok =
    typeof id === "number"
      ? Number.isSafeInteger(id) && id >= 0
      : typeof id === "string" && /^[0-9]+$/.test(id);
  return ok ? undefined : "Expected a numeric id (digits only).";
};

/**
 * The path segment for a resource id: checked with {@link resourceIdProblem}
 * (throws FdsValidationError `Invalid id: ...`), returned as a string.
 */
export function normalizeResourceId(id: number | string): string {
  return String(assertValid("id", id, resourceIdProblem));
}

/**
 * Rule for an enumerated filter: one of `allowed` (exact match). The message
 * matches the CLI's choice check: `Allowed choices are a, b, c.`
 */
export function oneOfProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) =>
    (allowed as readonly unknown[]).includes(value)
      ? undefined
      : `Allowed choices are ${allowed.join(", ")}.`;
}

/** Rule for a boolean filter: `true` or `false` (sent as the strings "true"/"false"). */
export const booleanProblem: Problem<unknown> = (value) =>
  typeof value === "boolean" ? undefined : "Expected a boolean (true or false).";

/** The rules for a params object, by parameter name. */
export type ParamRules = Readonly<Record<string, Problem<unknown>>>;

/**
 * Check every parameter that has a rule and a value (`undefined` and `null` mean
 * "omitted"); throws FdsValidationError (`Invalid <param>: <reason>`) at the first
 * problem. Parameters without a rule pass unchecked here.
 */
export function validateParams(params: object, rules: ParamRules): void {
  const values = params as Record<string, unknown>;
  for (const [name, problem] of Object.entries(rules)) {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (value !== undefined && value !== null) assertValid(name, value, problem);
  }
}

/** Rule for `offset`: a non-negative safe integer. */
export const offsetProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : "Expected a non-negative integer.";

/**
 * Rule for `limit`: an integer from 1 to {@link MAX_PAGE_SIZE}. The server silently
 * clamps anything larger, and `0`, to 50, so a caller asking for 100 rows would get
 * 50 without an error (and a CSV page carries no `meta` to show it).
 */
export const limitProblem: Problem<unknown> = (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "Expected an integer.";
  if (value < 1) return "Must be >= 1.";
  if (value > MAX_PAGE_SIZE) return `Must be <= ${MAX_PAGE_SIZE}.`;
  return undefined;
};

const PAGINATION_RULES: ParamRules = { offset: offsetProblem, limit: limitProblem };

/** Check `offset` and `limit` (when present); throws FdsValidationError. */
export function validatePagination(page: Pagination): void {
  validateParams(page, PAGINATION_RULES);
}

/**
 * Rule for a point filter given as two comma-separated decimal numbers, in the
 * order the API parameter uses (`latlng` on georegion, `lnglat` on publicbody), with
 * the latitude within ±90 and the longitude within ±180. The API silently ignores a
 * point it cannot parse and returns the whole unfiltered table; the range check
 * also catches a swapped pair such as a longitude of 120 given as latitude.
 */
export function pointProblem(order: "lat,lng" | "lng,lat"): Problem<unknown> {
  return (value) => {
    if (isBlank(value)) return "Expected a non-empty value.";
    const match =
      typeof value === "string" ? /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value) : null;
    if (!match) {
      const example = order === "lat,lng" ? "51.34,12.37" : "12.37,51.34";
      return `Expected "${order}" as two decimal numbers, e.g. ${example}.`;
    }
    const [a, b] = [Number(match[1]), Number(match[2])];
    const [lat, lng] = order === "lat,lng" ? [a, b] : [b, a];
    if (Math.abs(lat) > 90) return `Latitude ${lat} is out of range (-90..90); the order is ${order}.`;
    if (Math.abs(lng) > 180) return `Longitude ${lng} is out of range (-180..180); the order is ${order}.`;
    return undefined;
  };
}
