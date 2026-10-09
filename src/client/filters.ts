// The query parameters each list, search and autocomplete endpoint accepts, and the check
// that holds a call to them.
//
// FragDenStaat (Froide on django-filter) ignores a query parameter it does not know, and
// several filters drop themselves silently on a value they cannot parse: `requests.list({
// jurisdicton: 1 })` or `publicBodies.search({ category: 9 })` answer with the whole set,
// `georegion ?id=abc` and `document ?ids=26,abc` return the whole table (Froide's
// `id_filter`/`filter_ids` catch the ValueError and skip the filter), and a repeated key
// (`jurisdiction=1&jurisdiction=91`) keeps only the last value. So every call checks its
// parameters against these tables before the request (`assertParams`): an unknown key, a
// wrong value type, a list where the API reads one value, or a malformed id list is an
// FdsValidationError. A parameter the server adds after these tables were written can
// still be sent with `{ allowUnknownFilters: true }` as the call's second argument.
//
// The parameter semantics come from Froide's FilterSets (okfde/froide,
// okfde/django-filingcabinet) and were checked against the live API.

import { FdsValidationError, cutText } from "./errors.js";
import {
  amountProblem,
  assertValid,
  booleanProblem,
  idFilterProblem,
  isBlank,
  limitProblem,
  nonBlankProblem,
  offsetProblem,
  oneOfProblem,
  pointProblem,
  type Problem,
} from "./validate.js";
import {
  GeoRegionKindValues,
  MessageKindValues,
  RequestResolutionValues,
  RequestStatusValues,
} from "./enums.js";
import type { QueryParams, QueryValue } from "./query.js";

/** Options of a list, search or CSV call. */
export interface FilterOptions {
  /**
   * Send parameters the tables in `filters.ts` don't know: a parameter the server added
   * after they were written. Default `false`: an unknown key is rejected, because the
   * API ignores it and answers with the unfiltered result.
   */
  allowUnknownFilters?: boolean;
}

/**
 * What one query parameter takes. `rule` checks one value; `list` says how the API
 * takes several: `"comma"` as one comma-separated value (`ids=26,27`, sent canonical,
 * without spaces), `"repeat"` as a repeated key (`category=1&category=2`, which Froide's
 * multiple-choice filters read in full). Without `list`, an array is rejected: Django
 * keeps only the last of repeated keys. `normalize` turns a valid value into the form
 * that is sent (an id as a number).
 */
export interface ParamKind {
  readonly rule: Problem<unknown>;
  readonly list?: "comma" | "repeat";
  readonly normalize?: (value: unknown) => QueryValue;
}

/** The parameters of one endpoint, by name. */
export type ParamSpec = Readonly<Record<string, ParamKind>>;

/** Rule: a non-blank string (a slug, a name, free text). */
const stringProblem: Problem<unknown> = (value) =>
  typeof value === "string" ? nonBlankProblem(value) : "Expected a string.";

/** Rule: a date string (`YYYY-MM-DD`, the server checks the format) or a valid `Date`. */
const dateProblem: Problem<unknown> = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Expected a valid date." : undefined;
  return typeof value === "string" ? nonBlankProblem(value) : "Expected a date string or a Date.";
};

/** Rule: a non-negative integer (a tree depth, a hierarchy level), or its digit string. */
const nonNegativeIntProblem: Problem<unknown> = (value) => {
  if (isBlank(value)) return "Expected a non-empty value.";
  const ok =
    typeof value === "number"
      ? Number.isSafeInteger(value) && value >= 0
      : typeof value === "string" && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value));
  return ok ? undefined : "Expected a non-negative integer.";
};

/** Rule for an id filter: a non-negative integer or its digit string (`idFilterProblem`). */
const idProblem: Problem<unknown> = idFilterProblem;

/** The elements of a comma-separated id list (`"26,27"`, `"26, 27"`, `[26, 27]`). */
function idListElements(value: unknown): unknown[] | undefined {
  if (typeof value === "string") return value.split(",").map((part) => part.trim());
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v.trim() : v));
  if (typeof value === "number") return [value];
  return undefined;
}

/**
 * Rule for a comma-separated id list (`document ids`, georegion `id`, public-body
 * `regions`): one or more non-negative integers, as `"26,27"` (spaces around the commas
 * are fine), a number or an array of them. Froide converts every element with `int()` and
 * drops the whole filter when one fails, answering with the unfiltered table: `ids=26,abc`
 * and `ids=26;27` returned all 259 575 documents.
 */
export const idListProblem: Problem<unknown> = (value) => {
  if (isBlank(value)) return "Expected a non-empty value.";
  const elements = idListElements(value);
  if (elements === undefined || elements.length === 0) {
    return "Expected a comma-separated list of numeric ids, e.g. 26,27.";
  }
  for (const element of elements) {
    if (element === "" || idFilterProblem(element) !== undefined) {
      return "Expected a comma-separated list of numeric ids, e.g. 26,27.";
    }
  }
  return undefined;
};

/** The canonical form of a valid id list: `"26,27"` (no spaces, no leading zeros). */
export function normalizeIdList(value: unknown): string {
  return (idListElements(value) ?? []).map((element) => String(Number(element))).join(",");
}

/**
 * Rule for request `campaign`: a campaign id, or `"-"` for requests that belong to no
 * campaign (Froide's `null_value`).
 */
const campaignProblem: Problem<unknown> = (value) => (value === "-" ? undefined : idProblem(value));

const STRING: ParamKind = { rule: stringProblem };
const DATE: ParamKind = { rule: dateProblem };
const BOOL: ParamKind = { rule: booleanProblem };
const AMOUNT: ParamKind = { rule: amountProblem };
const ID: ParamKind = { rule: idProblem, normalize: (v) => Number(v) };
const IDS_REPEATED: ParamKind = { rule: idProblem, list: "repeat", normalize: (v) => Number(v) };
const ID_LIST: ParamKind = { rule: idListProblem, list: "comma", normalize: normalizeIdList };
const INT: ParamKind = { rule: nonNegativeIntProblem, normalize: (v) => Number(v) };
const oneOf = (values: readonly string[]): ParamKind => ({ rule: oneOfProblem(values) });

/** `offset`/`limit`, shared by every list endpoint. */
export const PAGINATION_PARAMS: ParamSpec = {
  offset: { rule: offsetProblem },
  limit: { rule: limitProblem },
};

/** `requests.list` — GET /api/v1/request/ (Froide's FoiRequestFilter). */
export const REQUEST_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  status: oneOf(RequestStatusValues),
  resolution: oneOf(RequestResolutionValues),
  jurisdiction: ID,
  law: ID,
  /** The exact category **name** (`Umwelt`), not an id or slug: `public_body__categories__name`. */
  categories: STRING,
  /** The exact classification **name** (`Ministerium`): `public_body__classification__name`. */
  classification: STRING,
  campaign: { rule: campaignProblem, normalize: (v) => (v === "-" ? "-" : Number(v)) },
  public_body: ID,
  /** The exact tag name, case-sensitive (`tags__name`). */
  tags: STRING,
  reference: STRING,
  slug: STRING,
  is_foi: BOOL,
  checked: BOOL,
  has_same: BOOL,
  costs_min: AMOUNT,
  costs_max: AMOUNT,
  created_at_after: DATE,
  created_at_before: DATE,
  project: ID,
  user: ID,
  follower: ID,
};

/** `requests.search` — GET /api/v1/request/search/ (jurisdiction and category are slugs). */
export const REQUEST_SEARCH_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  q: STRING,
  jurisdiction: STRING,
  category: STRING,
};

/** `publicBodies.list` — GET /api/v1/publicbody/ (Froide's PublicBodyFilter). */
export const PUBLICBODY_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  q: STRING,
  jurisdiction: ID,
  classification: ID,
  classification_id: ID,
  /** A multiple-choice filter: several ids are sent as repeated keys. */
  category: IDS_REPEATED,
  /** One id (that region and its sub-regions) or a comma list (exactly those regions). */
  regions: ID_LIST,
  slug: STRING,
  lnglat: { rule: pointProblem("lng,lat") },
};

/**
 * `publicBodies.search` — GET /api/v1/publicbody/search/ (Froide's PublicBodyAPIFilterSet):
 * the category is the plural `categories`; `regions` is a multiple-choice filter.
 */
export const PUBLICBODY_SEARCH_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  q: STRING,
  jurisdiction: ID,
  classification: ID,
  categories: ID,
  regions: IDS_REPEATED,
  regions_kind: oneOf(GeoRegionKindValues),
};

/** `laws.list` — GET /api/v1/law/. */
export const LAW_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  q: STRING,
  jurisdiction: ID,
  mediator: ID,
  meta: BOOL,
  id: ID,
};

/** `classifications.list` — GET /api/v1/classification/ (no `is_topic`). */
export const CLASSIFICATION_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  q: STRING,
  name: STRING,
  parent: ID,
  ancestor: ID,
  depth: INT,
};

/** `categories.list` — GET /api/v1/category/. */
export const CATEGORY_LIST_PARAMS: ParamSpec = {
  ...CLASSIFICATION_LIST_PARAMS,
  is_topic: BOOL,
};

/** `messages.list` — GET /api/v1/message/. */
export const MESSAGE_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  request: ID,
  kind: oneOf(MessageKindValues),
  is_response: BOOL,
  is_draft: BOOL,
};

/** `documents.list` — GET /api/v1/document/ (filingcabinet's DocumentFilter). */
export const DOCUMENT_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  publicbody: ID,
  foirequest: ID,
  collection: ID,
  portal: ID,
  directory: ID,
  /** A tag **slug** (`to_field_name="slug"`). */
  tag: STRING,
  ids: ID_LIST,
  created_at_after: DATE,
  created_at_before: DATE,
};

/** `georegions.list` — GET /api/v1/georegion/. */
export const GEOREGION_LIST_PARAMS: ParamSpec = {
  ...PAGINATION_PARAMS,
  q: STRING,
  name: STRING,
  kind: oneOf(GeoRegionKindValues),
  kind_detail: STRING,
  level: INT,
  region_identifier: STRING,
  slug: STRING,
  ancestor: ID,
  /** A comma list of region ids. */
  id: ID_LIST,
  latlng: { rule: pointProblem("lat,lng") },
};

/** `jurisdictions.list`, `campaigns.list`: pagination only. */
export const PAGE_ONLY_PARAMS: ParamSpec = PAGINATION_PARAMS;

/** A value of a parameter the tables don't know, sent with allowUnknownFilters: a scalar or a list of them. */
const anyScalarProblem: Problem<unknown> = (value) => {
  const scalar = (v: unknown): boolean =>
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (v instanceof Date && !Number.isNaN(v.getTime()));
  if (Array.isArray(value) ? value.length > 0 && value.every(scalar) : scalar(value)) return undefined;
  return "Expected a string, number, boolean or Date, or a list of them.";
};

/** Edit distance of two short strings (for "did you mean"). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/**
 * The known name `key` most likely means (`jurisdicton`, `Status`, `publicBody`, or the
 * singular/plural twin: `category` for `categories`), if any.
 */
function suggest(key: string, known: readonly string[]): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, "");
  const stem = (s: string): string => norm(s).replace(/ies$/, "y").replace(/s$/, "");
  const exact = known.find((k) => norm(k) === norm(key)) ?? known.find((k) => stem(k) === stem(key));
  if (exact !== undefined) return exact;
  let best: string | undefined;
  let bestDistance = 3;
  for (const k of known) {
    const d = distance(norm(key), norm(k));
    if (d < bestDistance) [best, bestDistance] = [k, d];
  }
  return best;
}

/** A parameter name as an error message shows it: quoted and escaped, cut at 100 characters. */
function quoteKey(key: string): string {
  return JSON.stringify(key.length > 100 ? `${cutText(key, 100)}…` : key);
}

/**
 * Check a call's parameters against its endpoint's table and return the query to send,
 * normalised (ids as numbers, id lists as `"26,27"`). Throws FdsValidationError for:
 * anything but a plain object; an unknown key — own keys only, so a `__proto__` or
 * `constructor` key from JSON counts — with a "did you mean" when one is close; a value
 * its rule rejects; and an array for a parameter the API reads once. `undefined` and
 * `null` values mean "omitted". With `allowUnknownFilters`, an unknown key is sent as
 * long as its value is a scalar or a list of scalars.
 */
export function assertParams(params: unknown, spec: ParamSpec, options: FilterOptions = {}): QueryParams {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new FdsValidationError("Invalid parameters: Expected an object of query parameters.");
  }
  const known = Object.keys(spec);
  const query: QueryParams = {};
  for (const key of Object.keys(params)) {
    const value = (params as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    const kind = Object.prototype.hasOwnProperty.call(spec, key) ? spec[key] : undefined;
    if (kind === undefined) {
      if (options?.allowUnknownFilters === true && key.trim() !== "" && key !== "__proto__") {
        assertValid(quoteKey(key), value, anyScalarProblem);
        query[key] = value as QueryValue;
        continue;
      }
      const hint = suggest(key, known);
      throw new FdsValidationError(
        `Invalid parameter ${quoteKey(key)}: not a parameter of this endpoint, which would ignore it` +
          (hint === undefined ? "" : ` (did you mean "${hint}"?)`) +
          `. Known: ${known.join(", ")}. Pass { allowUnknownFilters: true } to send it anyway.`,
      );
    }
    query[key] = checkValue(key, value, kind);
  }
  return query;
}

function checkValue(key: string, value: unknown, kind: ParamKind): QueryValue {
  const normalize = kind.normalize ?? ((v: unknown) => v as QueryValue);
  if (Array.isArray(value) && kind.list !== "comma") {
    if (kind.list !== "repeat") {
      throw new FdsValidationError(
        `Invalid ${key}: Expected a single value, not a list: the API reads only the last of repeated keys.`,
      );
    }
    if (value.length === 0) throw new FdsValidationError(`Invalid ${key}: Expected at least one value.`);
    return value.map((element) => normalize(assertValid(key, element, kind.rule))) as QueryValue;
  }
  return normalize(assertValid(key, value, kind.rule));
}
