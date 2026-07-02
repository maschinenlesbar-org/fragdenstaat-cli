// Strongly-typed parameter objects for the list/search endpoints. These mirror
// the query parameters the API accepts (confirmed against the live API). Every
// field is optional; omitted fields are simply not sent. Id-valued filters accept
// a number or the equivalent string.

import type { RequestStatus, RequestResolution, MessageKind, GeoRegionKind } from "./enums.js";

/** Offset/limit pagination shared by every list endpoint. */
export interface Pagination {
  offset?: number;
  /** Page size. The server caps this (see DEVELOPING.md); defaults server-side. */
  limit?: number;
}

type Id = number | string;

/** Filters for `GET /api/v1/request/` (FOI requests). */
export interface RequestListParams extends Pagination {
  status?: RequestStatus;
  resolution?: RequestResolution;
  jurisdiction?: Id;
  law?: Id;
  categories?: Id;
  classification?: Id;
  campaign?: Id;
  public_body?: Id;
  tags?: string;
  reference?: string;
  slug?: string;
  is_foi?: boolean;
  checked?: boolean;
  has_same?: boolean;
  costs_min?: number;
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
  category?: Id;
  regions?: Id;
  slug?: string;
  /** `lng,lat` pair to sort/filter by proximity. */
  lnglat?: string;
}

/** Filters for `GET /api/v1/law/` (FOI laws). */
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
  depth?: number;
  is_topic?: boolean;
}

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
  /** A tag id (numeric); the API rejects free-text tag names here. */
  tag?: Id;
  /** Comma-separated list of document ids. */
  ids?: string;
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
  id?: Id;
  /** `lat,lng` pair for point-in-region lookup. */
  latlng?: string;
}
