// Strongly-typed parameter objects for the list/search endpoints. These mirror
// the query parameters the API accepts (confirmed against the live API and Froide's
// FilterSets). Every field is optional; omitted fields are simply not sent. Id-valued
// filters accept a non-negative integer or its digit string and are sent as numbers.
// The library checks every call against the tables in `filters.ts` at run time: an
// unknown key, a wrong type or a list where the API reads one value is an
// FdsValidationError (pass `{ allowUnknownFilters: true }` to send an unknown key).

import type { RequestStatus, RequestResolution, MessageKind, GeoRegionKind } from "./enums.js";

/**
 * The server's page size: the default and the largest `limit` it honours. It
 * silently clamps a larger `limit` (and `limit=0`) to this, so the client rejects
 * them instead.
 */
export const MAX_PAGE_SIZE = 50;

/** Offset/limit pagination shared by every list endpoint. */
export interface Pagination {
  /** Position in the whole result set: a non-negative integer. */
  offset?: number | undefined;
  /** Page size: an integer from 1 to `MAX_PAGE_SIZE` (50); defaults server-side to 50. */
  limit?: number | undefined;
}

type Id = number | string;
/** Several ids: `"26,27"` (spaces around the commas allowed) or `[26, 27]`. */
type IdList = Id | Id[];

/** Filters for `GET /api/v1/request/` (FOI requests). */
export interface RequestListParams extends Pagination {
  status?: RequestStatus | undefined;
  resolution?: RequestResolution | undefined;
  jurisdiction?: Id | undefined;
  law?: Id | undefined;
  /**
   * The exact **name** of a category, case-sensitive (`"Umwelt"`, as `categories.list`
   * shows it) — not its id or slug, which match nothing. Matches requests whose public
   * body is in that category.
   */
  categories?: string | undefined;
  /**
   * The exact **name** of a public-body classification, case-sensitive
   * (`"Ministerium"`) — not its id or slug, which match nothing.
   */
  classification?: string | undefined;
  /** A campaign id, or `"-"` for requests that belong to no campaign. */
  campaign?: Id | undefined;
  public_body?: Id | undefined;
  /** One tag name, exact and case-sensitive (as `requests.tagsAutocomplete` returns it). */
  tags?: string | undefined;
  reference?: string | undefined;
  slug?: string | undefined;
  is_foi?: boolean | undefined;
  checked?: boolean | undefined;
  has_same?: boolean | undefined;
  /** Minimum charged costs in EUR: a finite non-negative number. */
  costs_min?: number | undefined;
  /** Maximum charged costs in EUR: a finite non-negative number. */
  costs_max?: number | undefined;
  /** Created on or after this day: `YYYY-MM-DD`, or a `Date` at midnight UTC (sent as its day). */
  created_at_after?: string | Date | undefined;
  /** Created on or before this day: `YYYY-MM-DD`, or a `Date` at midnight UTC (sent as its day). */
  created_at_before?: string | Date | undefined;
  project?: Id | undefined;
  user?: Id | undefined;
  follower?: Id | undefined;
}

/**
 * Filters for `GET /api/v1/request/search/` (full-text request search).
 *
 * NOTE: the search endpoint's `status` filter is intentionally not modelled — its
 * server-side choice set rejects every documented request status (HTTP 400), so it
 * is unusable. Use `RequestListParams.status` on the plain list endpoint instead.
 */
export interface RequestSearchParams extends Pagination {
  q?: string | undefined;
  jurisdiction?: string | undefined;
  category?: string | undefined;
}

/** Filters for `GET /api/v1/publicbody/` (public bodies). */
export interface PublicBodyListParams extends Pagination {
  q?: string | undefined;
  jurisdiction?: Id | undefined;
  classification?: Id | undefined;
  classification_id?: Id | undefined;
  /** Category id(s): several are sent as repeated keys, which the API ORs. */
  category?: Id | Id[] | undefined;
  /**
   * One geo-region id (that region and its sub-regions) or a comma list `"1,2"` / `[1, 2]`
   * (exactly those regions). Upstream, a single id that doesn't exist filters nothing, so
   * the client looks each id up first and rejects an unknown one (FdsValidationError).
   */
  regions?: IdList | undefined;
  slug?: string | undefined;
  /**
   * `lng,lat` point: keeps bodies whose `regions` contain it. Results are not
   * sorted by distance, and a body matching through several regions repeats.
   */
  lnglat?: string | undefined;
}

/**
 * Filters for `GET /api/v1/publicbody/search/` (public-body full-text search). The
 * category is the **plural** `categories` (the endpoint ignores a singular `category`),
 * and the endpoint has no `classification_id`, `slug` or `lnglat` (it ignores them).
 * `classification` is its working classification filter (checked live 2026-10-06:
 * id 118, Ministerium, narrowed 10000 hits to 225).
 */
export interface PublicBodySearchParams extends Pagination {
  q?: string | undefined;
  jurisdiction?: Id | undefined;
  classification?: Id | undefined;
  /** Category id. */
  categories?: Id | undefined;
  /** Geo-region id(s); several are sent as repeated keys. Each is looked up first; an unknown one rejects. */
  regions?: Id | Id[] | undefined;
  /** Only bodies in regions of this kind. */
  regions_kind?: GeoRegionKind | undefined;
}

/**
 * Filters for `GET /api/v1/law/` (FOI laws). `jurisdiction`, `mediator` and `id` must
 * be a non-negative integer or a digit string, and are sent as numbers (`"007"` as
 * `7`); the API ignores a non-numeric value there and returns every law.
 */
export interface LawListParams extends Pagination {
  q?: string | undefined;
  jurisdiction?: Id | undefined;
  mediator?: Id | undefined;
  meta?: boolean | undefined;
  id?: Id | undefined;
}

/** Filters for `GET /api/v1/category/` and `/api/v1/classification/` (taxonomy trees). */
export interface TreeListParams extends Pagination {
  q?: string | undefined;
  name?: string | undefined;
  parent?: Id | undefined;
  ancestor?: Id | undefined;
  /** Tree depth: a non-negative integer. */
  depth?: number | undefined;
  /** Categories only: `classifications.list` rejects it (the endpoint ignores it). */
  is_topic?: boolean | undefined;
}

/** Filters for `GET /api/v1/classification/`: like categories, without `is_topic`. */
export type ClassificationListParams = Omit<TreeListParams, "is_topic">;

/** Filters for `GET /api/v1/message/` (correspondence). */
export interface MessageListParams extends Pagination {
  request?: Id | undefined;
  kind?: MessageKind | undefined;
  is_response?: boolean | undefined;
  is_draft?: boolean | undefined;
}

/** Filters for `GET /api/v1/document/` (published documents). */
export interface DocumentListParams extends Pagination {
  publicbody?: Id | undefined;
  foirequest?: Id | undefined;
  collection?: Id | undefined;
  portal?: Id | undefined;
  directory?: Id | undefined;
  /** A tag **slug** (the API matches the tag's slug; an unknown one matches nothing). */
  tag?: string | undefined;
  /**
   * Document ids: `"26,27"` or `[26, 27]`. Every element must be an integer — upstream,
   * one bad element (`"26,abc"`, `"26;27"`) drops the whole filter.
   */
  ids?: IdList | undefined;
  /** Created on or after this day: `YYYY-MM-DD`, or a `Date` at midnight UTC (sent as its day). */
  created_at_after?: string | Date | undefined;
  /** Created on or before this day: `YYYY-MM-DD`, or a `Date` at midnight UTC (sent as its day). */
  created_at_before?: string | Date | undefined;
}

/** Filters for `GET /api/v1/georegion/` (geographic regions). */
export interface GeoRegionListParams extends Pagination {
  q?: string | undefined;
  name?: string | undefined;
  kind?: GeoRegionKind | undefined;
  kind_detail?: string | undefined;
  level?: number | undefined;
  region_identifier?: string | undefined;
  slug?: string | undefined;
  ancestor?: Id | undefined;
  /** Region id(s): `5`, `"5,6"` or `[5, 6]`; one non-numeric element dropped the filter upstream. */
  id?: IdList | undefined;
  /** `lat,lng` pair for point-in-region lookup. */
  latlng?: string | undefined;
}
