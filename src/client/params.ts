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
  offset?: number;
  /** Page size: an integer from 1 to `MAX_PAGE_SIZE` (50); defaults server-side to 50. */
  limit?: number;
}

type Id = number | string;
/** Several ids: `"26,27"` (spaces around the commas allowed) or `[26, 27]`. */
type IdList = Id | Id[];

/** Filters for `GET /api/v1/request/` (FOI requests). */
export interface RequestListParams extends Pagination {
  status?: RequestStatus;
  resolution?: RequestResolution;
  jurisdiction?: Id;
  law?: Id;
  /**
   * The exact **name** of a category, case-sensitive (`"Umwelt"`, as `categories.list`
   * shows it) — not its id or slug, which match nothing. Matches requests whose public
   * body is in that category.
   */
  categories?: string;
  /**
   * The exact **name** of a public-body classification, case-sensitive
   * (`"Ministerium"`) — not its id or slug, which match nothing.
   */
  classification?: string;
  /** A campaign id, or `"-"` for requests that belong to no campaign. */
  campaign?: Id;
  public_body?: Id;
  /** One tag name, exact and case-sensitive (as `requests.tagsAutocomplete` returns it). */
  tags?: string;
  reference?: string;
  slug?: string;
  is_foi?: boolean;
  checked?: boolean;
  has_same?: boolean;
  /** Minimum charged costs in EUR: a finite non-negative number. */
  costs_min?: number;
  /** Maximum charged costs in EUR: a finite non-negative number. */
  costs_max?: number;
  created_at_after?: string;
  created_at_before?: string;
  project?: Id;
  user?: Id;
  follower?: Id;
}

/**
 * Filters for `GET /api/v1/request/search/` (full-text request search).
 *
 * NOTE: the search endpoint's `status` filter is intentionally not modelled — its
 * server-side choice set rejects every documented request status (HTTP 400), so it
 * is unusable. Use `RequestListParams.status` on the plain list endpoint instead.
 */
export interface RequestSearchParams extends Pagination {
  q?: string;
  jurisdiction?: string;
  category?: string;
}

/** Filters for `GET /api/v1/publicbody/` (public bodies). */
export interface PublicBodyListParams extends Pagination {
  q?: string;
  jurisdiction?: Id;
  classification?: Id;
  classification_id?: Id;
  /** Category id(s): several are sent as repeated keys, which the API ORs. */
  category?: Id | Id[];
  /**
   * One geo-region id (that region and its sub-regions) or a comma list `"1,2"` / `[1, 2]`
   * (exactly those regions). Upstream, a single id that doesn't exist filters nothing, so
   * the client looks each id up first and rejects an unknown one (FdsValidationError).
   */
  regions?: IdList;
  slug?: string;
  /**
   * `lng,lat` point: keeps bodies whose `regions` contain it. Results are not
   * sorted by distance, and a body matching through several regions repeats.
   */
  lnglat?: string;
}

/**
 * Filters for `GET /api/v1/publicbody/search/` (public-body full-text search). The
 * category is the **plural** `categories` (the endpoint ignores a singular `category`),
 * and the endpoint has no `classification_id`, `slug` or `lnglat`.
 */
export interface PublicBodySearchParams extends Pagination {
  q?: string;
  jurisdiction?: Id;
  classification?: Id;
  /** Category id. */
  categories?: Id;
  /** Geo-region id(s); several are sent as repeated keys. Each is looked up first; an unknown one rejects. */
  regions?: Id | Id[];
  /** Only bodies in regions of this kind. */
  regions_kind?: GeoRegionKind;
}

/**
 * Filters for `GET /api/v1/law/` (FOI laws). `jurisdiction`, `mediator` and `id` must
 * be a non-negative integer or a digit string, and are sent as numbers (`"007"` as
 * `7`); the API ignores a non-numeric value there and returns every law.
 */
export interface LawListParams extends Pagination {
  q?: string;
  jurisdiction?: Id;
  mediator?: Id;
  meta?: boolean;
  id?: Id;
}

/** Filters for `GET /api/v1/category/` and `/api/v1/classification/` (taxonomy trees). */
export interface TreeListParams extends Pagination {
  q?: string;
  name?: string;
  parent?: Id;
  ancestor?: Id;
  /** Tree depth: a non-negative integer. */
  depth?: number;
  /** Categories only: `classifications.list` rejects it (the endpoint ignores it). */
  is_topic?: boolean;
}

/** Filters for `GET /api/v1/classification/`: like categories, without `is_topic`. */
export type ClassificationListParams = Omit<TreeListParams, "is_topic">;

/** Filters for `GET /api/v1/message/` (correspondence). */
export interface MessageListParams extends Pagination {
  request?: Id;
  kind?: MessageKind;
  is_response?: boolean;
  is_draft?: boolean;
}

/** Filters for `GET /api/v1/document/` (published documents). */
export interface DocumentListParams extends Pagination {
  publicbody?: Id;
  foirequest?: Id;
  collection?: Id;
  portal?: Id;
  directory?: Id;
  /** A tag **slug** (the API matches the tag's slug; an unknown one matches nothing). */
  tag?: string;
  /**
   * Document ids: `"26,27"` or `[26, 27]`. Every element must be an integer — upstream,
   * one bad element (`"26,abc"`, `"26;27"`) drops the whole filter.
   */
  ids?: IdList;
  created_at_after?: string;
  created_at_before?: string;
}

/** Filters for `GET /api/v1/georegion/` (geographic regions). */
export interface GeoRegionListParams extends Pagination {
  q?: string;
  name?: string;
  kind?: GeoRegionKind;
  kind_detail?: string;
  level?: number;
  region_identifier?: string;
  slug?: string;
  ancestor?: Id;
  /** Region id(s): `5`, `"5,6"` or `[5, 6]`; one non-numeric element dropped the filter upstream. */
  id?: IdList;
  /** `lat,lng` pair for point-in-region lookup. */
  latlng?: string;
}
