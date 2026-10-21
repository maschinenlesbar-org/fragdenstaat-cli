// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { FdsValidationError, cutForMessage, quoteValue, redactUrl } from "./errors.js";
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

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True for a string in which nothing would match anything: empty, or only whitespace, control
 * and format characters (a zero-width space, a soft hyphen) and combining marks. Such a value
 * reads as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
export function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter (a search term, a name the API matches), or
 * undefined when it can. Refused, before any request, as the API would match nothing or
 * everything:
 * - a value that is blank once trimmed, or that holds only invisible characters and combining
 *   marks (`isBlank`): an empty filter reads as "no filter" upstream, which answers with the
 *   whole unfiltered list;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a slug, a code, a
 * reference, a date or an id: a value the API compares exactly. The rules apply to the value
 * with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and
 * not only invisible characters or combining marks), no lone surrogate, and no control or
 * format character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an
 * invisible character in a slug or an id only ever makes it match nothing. The reason quotes
 * the value visibly.
 */
export function tokenProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list value (`--ids 26,27`), as typed: each item is then checked
 * (`listProblem`) and canonicalised on its own, so `"26, 27"` sends `27`, and `"26,,27"`, `"26,"`
 * and `","` are refused rather than sent as an empty item (which an API may read as "no filter").
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array, no item at all
 * (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by default
 * {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly unknown[], itemProblem: Problem<unknown> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i]);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
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
 * A free-text value as the API matches it (a search term, a name filter): without
 * surrounding whitespace (a value pasted with a trailing space matched nothing) and in
 * composed Unicode, NFC (a decomposed "Müller", u plus U+0308 as pasted from a macOS file
 * name, matched nothing). Inner whitespace is kept. Check it with {@link textProblem} first.
 * Slugs, references, codes and dates are tokens ({@link normalizeToken}), trimmed and in NFC
 * too.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * Rule for an autocomplete query `q`: a non-blank string. `undefined` or `null` would
 * send no `q` at all, which the API answers with every suggestion.
 */
export const queryTextProblem: Problem<unknown> = (value) =>
  typeof value === "string" ? textProblem(value) : "Expected a non-empty value.";

/**
 * Rule for a resource id in a detail path (`get(id)`): every wrapped detail
 * endpoint takes an integer id, so a number must be a non-negative safe integer and
 * a string a run of ASCII digits. Anything else would re-target the request: `"search"`
 * or `"autocomplete"` reach the list sub-endpoints and return a list envelope as if
 * it were a detail object, and `"."`/`".."` resolve to the list or the API root.
 */
export const resourceIdProblem: Problem<unknown> = (id) => {
  if (isBlank(id)) return "Expected a non-empty value.";
  // An invisible or control character, or half of one, is named and shown escaped (D10).
  const token = typeof id === "string" ? tokenProblem(id) : undefined;
  if (token !== undefined) return token;
  const ok =
    typeof id === "number"
      ? Number.isSafeInteger(id) && id >= 0
      : typeof id === "string" && /^[0-9]+$/.test(id);
  if (!ok) return "Expected a numeric id (digits only).";
  // Like the id filters: no database id is that large, and the server would most likely
  // fail on the integer overflow ("99999999999999999999").
  return Number.isSafeInteger(Number(id)) ? undefined : "Expected a numeric id up to 9007199254740991.";
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
    return `Invalid URL ${quoteValue(redactAnyUrl(value))}.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported protocol "${cutForMessage(url.protocol)}" (use http or https).`;
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
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = typeof value === "string" ? tokenProblem(value) : undefined;
  if (token !== undefined) return token;
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
