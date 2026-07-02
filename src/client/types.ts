// Domain types for the FragDenStaat.de API.
//
// The API is a Tastypie-style read API: list endpoints return a `{ meta, objects }`
// envelope and detail endpoints return the bare object. Related resources are
// hyperlinked as absolute `resource_uri` URLs rather than embedded. List items are
// typed precisely for the fields that matter; deeply nested / free-form sub-objects
// (a request's redacted description, a public body's geo, a message's attachments)
// are exposed as `JsonValue` so callers get the raw, faithful payload without us
// guessing at every nested field. Single-resource detail responses are returned as
// `JsonObject` for the same reason.

import type { RequestStatus, RequestResolution, MessageKind, GeoRegionKind } from "./enums.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Pagination/summary block on every Tastypie list response. */
export interface TastypieMeta {
  limit: number;
  offset: number;
  total_count: number;
  /** Absolute URL of the next page, or null on the last page. */
  next: string | null;
  /** Absolute URL of the previous page, or null on the first page. */
  previous: string | null;
}

/** The `{ meta, objects }` envelope returned by every list endpoint. */
export interface TastypieList<T> {
  meta: TastypieMeta;
  objects: T[];
}

/**
 * An FOI request (`Informationsfreiheitsanfrage`) — the central resource. Anonymous
 * callers see only public requests. List and detail share this shape; detail adds
 * an embedded `messages` array (see `FoiRequestDetail`).
 */
export interface FoiRequestListItem {
  resource_uri: string;
  id: number;
  /** Site-relative path to the request page, e.g. `/anfrage/<slug>/`. */
  url: string;
  title: string;
  slug: string;
  /** Hyperlink to the jurisdiction resource; null before one is assigned. */
  jurisdiction: string | null;
  jurisdiction_name: string | null;
  /** Hyperlink to the FOI law resource, or null. */
  law: string | null;
  /** The public body addressed, embedded as a nested object (may be null). */
  public_body: JsonValue;
  status: RequestStatus;
  status_representation: string;
  readable_status: string;
  /** Set once resolved; empty string while the request is still open. */
  resolution: RequestResolution | "";
  refusal_reason: string;
  is_foi: boolean;
  checked: boolean;
  public: boolean;
  costs: number;
  description: string;
  /** Array of `[isRedacted, textSegment]` tuples. */
  redacted_description: JsonValue;
  summary: string;
  reference: string;
  tags: string[];
  /** Campaign id or hyperlink when the request belongs to a campaign, else null. */
  campaign: string | number | null;
  /** Requesting user's id, or null (usually null for anonymous reads). */
  user: number | null;
  same_as: string | null;
  same_as_count: number;
  project: string | null;
  project_request_count: number | null;
  project_site_url: string | null;
  due_date: string | null;
  resolved_on: string | null;
  last_message: string | null;
  created_at: string;
  last_modified_at: string;
}

/** A public body / authority (`Behörde`) that FOI requests are addressed to. */
export interface PublicBodyListItem {
  resource_uri: string;
  id: number;
  name: string;
  slug: string;
  other_names: string;
  description: string;
  url: string;
  /** Hyperlink to the jurisdiction resource. */
  jurisdiction: string;
  classification: JsonValue;
  categories: JsonValue;
  laws: JsonValue;
  regions: JsonValue;
  email: string;
  contact: string;
  address: string;
  fax: string;
  alternative_emails: JsonValue;
  request_note: string;
  request_note_html: string;
  number_of_requests: number;
  parent: string | null;
  root: string | null;
  depth: number;
  geo: JsonValue;
  site_url: string;
  source_reference: string;
  wikidata_item: string | null;
  extra_data: JsonValue;
}

/** An FOI law (`IFG`, `UIG`, `VIG`, a state transparency act, or a local statute). */
export interface FoiLawListItem {
  resource_uri: string;
  id: number;
  name: string;
  slug: string;
  description: string;
  long_description: string;
  law_type: string;
  /** Hyperlink to the jurisdiction resource. */
  jurisdiction: string;
  meta: boolean;
  /** Hyperlinks to the laws a meta-law combines. */
  combined: JsonValue;
  mediator: string | null;
  email_only: boolean;
  requires_signature: boolean;
  max_response_time: number | null;
  max_response_time_unit: string;
  refusal_reasons: JsonValue;
  legal_text: string;
  letter_start: string;
  letter_end: string;
  request_note: string;
  request_note_html: string;
  priority: number;
  created: string | null;
  last_modified_at: string | null;
  site_url: string;
  url: string;
}

/** A jurisdiction (`Bund`, a `Land`, the EU, ...) whose FOI regime governs a request. */
export interface JurisdictionListItem {
  resource_uri: string;
  id: number;
  name: string;
  slug: string;
  description: string;
  rank: number;
  /** Hyperlink to the geo-region resource, or null. */
  region: string | null;
  region_kind: string;
  region_kind_detail: string;
  site_url: string;
  last_modified_at: string;
}

/** A topical category (`Kategorie`) attached to public bodies and requests. */
export interface CategoryListItem {
  id: number;
  name: string;
  slug: string;
  is_topic: boolean;
  depth: number;
  parent: number | null;
  children: JsonValue;
}

/** A public-body classification (`Behördentyp`), e.g. `Ministerium`, `Grundschule`. */
export interface ClassificationListItem {
  id: number;
  name: string;
  slug: string;
  depth: number;
  parent: number | null;
  children: JsonValue;
}

/** A campaign (`Kampagne`) bundling many related FOI requests. */
export interface CampaignListItem {
  resource_uri: string;
  id: number;
  name: string;
  slug: string;
  url: string;
  description: string;
  start_date: string | null;
  active: boolean;
}

/** A geographic region (`Region`): a country, state, district, municipality or zip code. */
export interface GeoRegionListItem {
  resource_uri: string;
  id: number;
  name: string;
  slug: string;
  kind: GeoRegionKind;
  kind_detail: string;
  level: number;
  region_identifier: string;
  global_identifier: string;
  area: number | null;
  population: number | null;
  valid_on: string | null;
  part_of: string | null;
  centroid: JsonValue;
}

/** A message (`Nachricht`) in the correspondence of an FOI request. */
export interface FoiMessageListItem {
  resource_uri: string;
  id: number;
  /** Hyperlink to the parent request. */
  request: string;
  url: string;
  kind: MessageKind;
  is_response: boolean;
  is_draft: boolean;
  is_escalation: boolean;
  is_postal: boolean;
  sent: boolean;
  status: string;
  status_name: string;
  subject: string;
  content: string;
  content_hidden: boolean;
  redacted: boolean;
  redacted_content: JsonValue;
  redacted_subject: JsonValue;
  sender: string;
  sender_public_body: string | null;
  recipient_public_body: string | null;
  not_publishable: boolean;
  registered_mail_date: string | null;
  timestamp: string;
  last_modified_at: string | null;
  attachments: JsonValue;
}

/** A published document (`Dokument`) extracted from FOI responses. */
export interface DocumentListItem {
  resource_uri: string;
  id: number;
  title: string;
  slug: string;
  description: string;
  /** Hyperlink to the source request, or null. */
  foirequest: string | null;
  publicbody: string | null;
  public: boolean;
  listed: boolean;
  pending: boolean;
  num_pages: number | null;
  file_size: number | null;
  file_url: string | null;
  cover_image: string | null;
  pages_uri: string | null;
  site_url: string;
  published_at: string | null;
  last_modified_at: string | null;
  uid: string;
  properties: JsonValue;
}
