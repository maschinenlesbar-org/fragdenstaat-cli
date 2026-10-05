// FragDenStaatClient — a typed, use-case-tailored client over the public,
// read-only endpoints of the FragDenStaat.de API (Freedom-of-Information portal).
// Only anonymous GET access is implemented; write endpoints (filing requests,
// sending messages, uploads) and the account/OAuth surface are intentionally out
// of scope. Anonymous callers see only public objects.
//
// The surface is grouped by resource so usage reads naturally, e.g.
//   client.requests.search({ q: "Umweltdaten" })
//   client.publicBodies.list({ jurisdiction: 1, classification: 5 })
//   client.laws.get(124)

import { RequestEngine, type EngineOptions, type RawResponse } from "./engine.js";
import type { QueryParams } from "./query.js";
import { assertValid, normalizeResourceId, queryTextProblem } from "./validate.js";
import {
  CATEGORY_LIST_PARAMS,
  CLASSIFICATION_LIST_PARAMS,
  DOCUMENT_LIST_PARAMS,
  GEOREGION_LIST_PARAMS,
  LAW_LIST_PARAMS,
  MESSAGE_LIST_PARAMS,
  PAGE_ONLY_PARAMS,
  PAGINATION_PARAMS,
  PUBLICBODY_LIST_PARAMS,
  PUBLICBODY_SEARCH_PARAMS,
  REQUEST_LIST_PARAMS,
  REQUEST_SEARCH_PARAMS,
  assertParams,
  type FilterOptions,
  type ParamSpec,
} from "./filters.js";
import type {
  TastypieList,
  JsonObject,
  FoiRequestListItem,
  PublicBodyListItem,
  FoiLawListItem,
  JurisdictionListItem,
  CategoryListItem,
  ClassificationListItem,
  CampaignListItem,
  GeoRegionListItem,
  FoiMessageListItem,
  DocumentListItem,
} from "./types.js";
import type {
  Pagination,
  RequestListParams,
  RequestSearchParams,
  PublicBodyListParams,
  PublicBodySearchParams,
  LawListParams,
  TreeListParams,
  ClassificationListParams,
  MessageListParams,
  DocumentListParams,
  GeoRegionListParams,
} from "./params.js";

/**
 * An `{ value, label }` autocomplete suggestion. `value` is an integer id for
 * public bodies, laws and geo-regions, but a **name string** for categories
 * (`{"value":"Digitales","label":"Digitales"}`; use `categories.list({ q })` for a
 * category id) and for request tags.
 */
export interface AutocompleteItem {
  value: number | string;
  label: string;
}

const CSV_ACCEPT = "text/csv";

/**
 * Check a params object against the endpoint's table (`filters.ts`: known keys, value
 * types, single values, id lists) and return the normalised query to send. Throws
 * FdsValidationError; every caller runs inside an async method, so the error arrives as
 * a rejection and no request is sent. `null`/`undefined` params count as none.
 */
function checkedQuery(params: unknown, spec: ParamSpec, options?: FilterOptions): QueryParams {
  return assertParams(params, spec, options ?? {});
}

/**
 * The query of an autocomplete call: `q` must be a non-blank string (`queryTextProblem`;
 * `undefined`/`null` used to send no `q`, which the API answers with every suggestion),
 * plus the checked pagination.
 */
function autocompleteQuery(q: string, page: Pagination | null | undefined): QueryParams {
  return { ...checkedQuery(page, PAGINATION_PARAMS), q: assertValid("q", q, queryTextProblem) };
}

/**
 * Generic Tastypie list/detail resource exposing `.list(params)` (the
 * `{ meta, objects }` envelope) and `.get(id)` (the bare detail object, returned
 * untyped as a faithful `JsonObject`).
 */
class ListResource<T, P extends Pagination = Pagination> {
  constructor(
    protected readonly e: RequestEngine,
    protected readonly path: string,
    private readonly spec: ParamSpec = PAGE_ONLY_PARAMS,
  ) {}

  /**
   * The filtered list. Every key, value type and id list is checked against this
   * endpoint's table first (FdsValidationError; `{ allowUnknownFilters: true }` sends a
   * key the table doesn't know).
   */
  async list(params: P = {} as P, options?: FilterOptions): Promise<TastypieList<T>> {
    return this.e.getJson(this.path, checkedQuery(params, this.spec, options), "list");
  }

  /**
   * The list endpoint as server-rendered CSV (nested objects flattened into
   * dotted columns). Returns the raw response for streaming to a file/stdout.
   */
  async listCsv(params: P = {} as P, options?: FilterOptions): Promise<RawResponse> {
    return this.e.getRaw(this.path, CSV_ACCEPT, { ...checkedQuery(params, this.spec, options), format: "csv" });
  }

  /**
   * One object by id. The id must be a non-negative integer or a digit string;
   * anything else rejects with an FdsValidationError before any request.
   */
  async get(id: number | string): Promise<JsonObject> {
    return this.e.getJson(`${this.path}${normalizeResourceId(id)}/`, undefined, "record");
  }
}

/** FOI requests, plus full-text search and tag autocomplete. */
class RequestResource extends ListResource<FoiRequestListItem, RequestListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/request/", REQUEST_LIST_PARAMS);
  }

  /** Full-text / faceted search over public requests. */
  async search(params: RequestSearchParams = {}, options?: FilterOptions): Promise<TastypieList<FoiRequestListItem>> {
    return this.e.getJson("/api/v1/request/search/", checkedQuery(params, REQUEST_SEARCH_PARAMS, options), "list");
  }

  /** The full-text request search as server-rendered CSV. */
  async searchCsv(params: RequestSearchParams = {}, options?: FilterOptions): Promise<RawResponse> {
    return this.e.getRaw("/api/v1/request/search/", CSV_ACCEPT, {
      ...checkedQuery(params, REQUEST_SEARCH_PARAMS, options),
      format: "csv",
    });
  }

  /** Autocomplete request tags. */
  async tagsAutocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/request/tags/autocomplete/", autocompleteQuery(q, page), "list");
  }
}

/** Public bodies, plus full-text search and name autocomplete. */
class PublicBodyResource extends ListResource<PublicBodyListItem, PublicBodyListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/publicbody/", PUBLICBODY_LIST_PARAMS);
  }

  /** Full-text search over public bodies. */
  async search(params: PublicBodySearchParams = {}, options?: FilterOptions): Promise<TastypieList<PublicBodyListItem>> {
    return this.e.getJson("/api/v1/publicbody/search/", checkedQuery(params, PUBLICBODY_SEARCH_PARAMS, options), "list");
  }

  /** The public-body search as server-rendered CSV. */
  async searchCsv(params: PublicBodySearchParams = {}, options?: FilterOptions): Promise<RawResponse> {
    return this.e.getRaw("/api/v1/publicbody/search/", CSV_ACCEPT, {
      ...checkedQuery(params, PUBLICBODY_SEARCH_PARAMS, options),
      format: "csv",
    });
  }

  /** Autocomplete public-body names. */
  async autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/publicbody/autocomplete/", autocompleteQuery(q, page), "list");
  }
}

/** FOI laws, plus name autocomplete. */
class LawResource extends ListResource<FoiLawListItem, LawListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/law/", LAW_LIST_PARAMS);
  }

  async autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/law/autocomplete/", autocompleteQuery(q, page), "list");
  }
}

/** Topical categories (a tree), plus name autocomplete. */
class CategoryResource extends ListResource<CategoryListItem, TreeListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/category/", CATEGORY_LIST_PARAMS);
  }

  async autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/category/autocomplete/", autocompleteQuery(q, page), "list");
  }
}

/** Geographic regions, plus name autocomplete. */
class GeoRegionResource extends ListResource<GeoRegionListItem, GeoRegionListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/georegion/", GEOREGION_LIST_PARAMS);
  }

  async autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/georegion/autocomplete/", autocompleteQuery(q, page), "list");
  }
}

export class FragDenStaatClient {
  private readonly engine: RequestEngine;

  readonly requests: RequestResource;
  readonly publicBodies: PublicBodyResource;
  readonly laws: LawResource;
  readonly jurisdictions: ListResource<JurisdictionListItem>;
  readonly categories: CategoryResource;
  readonly classifications: ListResource<ClassificationListItem, ClassificationListParams>;
  readonly campaigns: ListResource<CampaignListItem>;
  readonly messages: ListResource<FoiMessageListItem, MessageListParams>;
  readonly documents: ListResource<DocumentListItem, DocumentListParams>;
  readonly georegions: GeoRegionResource;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);

    this.requests = new RequestResource(this.engine);
    this.publicBodies = new PublicBodyResource(this.engine);
    this.laws = new LawResource(this.engine);
    this.jurisdictions = new ListResource(this.engine, "/api/v1/jurisdiction/");
    this.categories = new CategoryResource(this.engine);
    this.classifications = new ListResource(this.engine, "/api/v1/classification/", CLASSIFICATION_LIST_PARAMS);
    this.campaigns = new ListResource(this.engine, "/api/v1/campaign/");
    this.messages = new ListResource(this.engine, "/api/v1/message/", MESSAGE_LIST_PARAMS);
    this.documents = new ListResource(this.engine, "/api/v1/document/", DOCUMENT_LIST_PARAMS);
    this.georegions = new GeoRegionResource(this.engine);
  }
}
