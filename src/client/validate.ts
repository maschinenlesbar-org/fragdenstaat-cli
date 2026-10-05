// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { FdsValidationError, redactUrl } from "./errors.js";
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
 * Reject a query whose value (or array element) is a blank string or an invalid
 * `Date`, or which has a blank parameter name; throws {@link FdsValidationError} naming the parameter.
 * `undefined` and `null` still mean "omitted". The engine runs this on every
 * request's query before building the URL.
 */
export function assertNonBlankParams(params: QueryParams): void {
  for (const [key, value] of Object.entries(params)) {
    assertValid("parameter name", key, nonBlankProblem);
    for (const v of Array.isArray(value) ? value : [value]) assertValid(key, v, queryScalarProblem);
  }
}

/**
 * A blank string is invalid (nonBlankProblem), and so is a `Date` that holds no time
 * (`new Date("nope")`): serialising it threw a raw `RangeError: Invalid time value`.
 */
const queryScalarProblem: Problem<unknown> = (value) => {
  if (value instanceof Date && Number.isNaN(value.getTime())) return "Expected a valid date.";
  return nonBlankProblem(value);
};

/**
 * Rule for an autocomplete query `q`: a non-blank string. `undefined` or `null` would
 * send no `q` at all, which the API answers with every suggestion.
 */
export const queryTextProblem: Problem<unknown> = (value) =>
  typeof value === "string" && !isBlank(value) ? undefined : "Expected a non-empty value.";

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

/**
 * Rule for an HTTP header value (the User-Agent): a non-blank string with no C0
 * control character other than tab (so no CR/LF header injection), no DEL and
 * nothing above U+00FF. That is what Node's HTTP layer accepts; it throws an opaque
 * "Invalid character in header content" for the rest. Checked by char code so the
 * source stays free of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || isBlank(value)) return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * Rule for the base URL: no whitespace or control characters, around it or inside
 * it. `new URL()` trims surrounding whitespace and drops tabs and newlines silently,
 * so the URL check passes, but the engine appends request paths to the raw string:
 * `"https://h/ "` requested `/%20/api/v1/...`, and a custom transport received the
 * padded value as is.
 */
export const baseUrlSpaceProblem: Problem<string> = (value) => {
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  // C0, DEL, C1 and any Unicode whitespace inside the value.
  if (/[\u0000-\u001f\u007f-\u009f]|\s/u.test(value)) {
    return "A base URL cannot contain whitespace or control characters.";
  }
  return undefined;
};

/**
 * Hide the userinfo of a URL that may not parse: {@link redactUrl} for a parseable
 * one, else a textual `scheme://user:pw@` -> `scheme://***@` replacement.
 */
function redactAnyUrl(value: string): string {
  const redacted = redactUrl(value);
  return redacted !== value ? redacted : value.replace(/^([^:/?#\s]+:\/\/)[^/?#]*@/, "$1***@");
}

/**
 * Rule for the base URL, in this order: a string; no whitespace or control
 * characters ({@link baseUrlSpaceProblem}); parseable by `new URL()`; an `http:` or
 * `https:` scheme; no query or fragment. Request paths are appended to the base URL
 * as a string, so a `?` or `#` would swallow every path (`http://h/?x=1` requested
 * `/?x=1/api/...`, `http://h/#f` requested `/`); a `%` in the user name or password
 * that starts a valid escape (`%25` for a literal one: Node decodes the userinfo for the
 * Authorization header and failed at request time). Userinfo is allowed (Basic auth for
 * a protected mirror) and never appears in a message.
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a URL string.";
  const space = baseUrlSpaceProblem(value);
  if (space !== undefined) return space;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Invalid URL "${redactAnyUrl(value)}".`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported protocol "${url.protocol}" (use http or https).`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo into the Authorization header and throws "URI malformed" for a
  // "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * Check a base URL with {@link baseUrlProblem} (throws FdsValidationError
 * `Invalid baseUrl: ...`) and return it with trailing slashes stripped. The
 * `RequestEngine` constructor runs it on the raw `baseUrl` option. Idempotent.
 */
export function validateBaseUrl(value: string): string {
  return assertValid("baseUrl", value, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Rule for an id-valued filter that must be a number (the law filters
 * `jurisdiction`, `mediator`, `id`): a non-negative safe integer, or a string of
 * ASCII digits for one. The API ignores a non-numeric value there and returns the
 * whole unfiltered list.
 */
export const idFilterProblem: Problem<unknown> = (value) => {
  const ok =
    typeof value === "number"
      ? Number.isSafeInteger(value) && value >= 0
      : typeof value === "string" && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value));
  return ok ? undefined : "Expected a non-negative integer.";
};

/**
 * The canonical form of an id filter: checked with {@link idFilterProblem} (throws
 * FdsValidationError `Invalid <name>: ...`) and returned as a number, so `"007"` is
 * sent as `7`. Idempotent.
 */
export function normalizeIdFilter(name: string, value: number | string): number {
  return Number(assertValid(name, value, idFilterProblem));
}

/** Rule for an amount in EUR (`costs_min`, `costs_max`): a finite non-negative number. */
export const amountProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? undefined
    : "Expected a non-negative number.";
