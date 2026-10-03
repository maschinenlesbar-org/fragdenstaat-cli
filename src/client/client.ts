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
import {
  booleanProblem,
  normalizeResourceId,
  oneOfProblem,
  validateParams,
  type ParamRules,
} from "./validate.js";
import {
  GeoRegionKindValues,
  MessageKindValues,
  RequestResolutionValues,
  RequestStatusValues,
} from "./enums.js";
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
 * Per-resource rules for the list filters the TypeScript types restrict but
 * plain-JS callers (or JSON input) can still get wrong: enumerated values must be
 * one of the `enums.ts` arrays, boolean filters real booleans.
 */
const REQUEST_LIST_RULES: ParamRules = {
  status: oneOfProblem(RequestStatusValues),
  resolution: oneOfProblem(RequestResolutionValues),
  is_foi: booleanProblem,
  checked: booleanProblem,
  has_same: booleanProblem,
};
const LAW_LIST_RULES: ParamRules = { meta: booleanProblem };
const TREE_LIST_RULES: ParamRules = { is_topic: booleanProblem };
const MESSAGE_LIST_RULES: ParamRules = {
  kind: oneOfProblem(MessageKindValues),
  is_response: booleanProblem,
  is_draft: booleanProblem,
};
const GEOREGION_LIST_RULES: ParamRules = { kind: oneOfProblem(GeoRegionKindValues) };

/**
 * Generic Tastypie list/detail resource exposing `.list(params)` (the
 * `{ meta, objects }` envelope) and `.get(id)` (the bare detail object, returned
 * untyped as a faithful `JsonObject`).
 */
class ListResource<T, P extends Pagination = Pagination> {
  constructor(
    protected readonly e: RequestEngine,
    protected readonly path: string,
    private readonly rules: ParamRules = {},
  ) {}

  /**
   * Check the list params against this resource's rules (FdsValidationError on a
   * bad value) and return them as the query to send.
   */
  protected listQuery(params: P): QueryParams {
    validateParams(params, this.rules);
    return params as unknown as QueryParams;
  }

  async list(params: P = {} as P): Promise<TastypieList<T>> {
    return this.e.getJson(this.path, this.listQuery(params));
  }

  /**
   * The list endpoint as server-rendered CSV (nested objects flattened into
   * dotted columns). Returns the raw response for streaming to a file/stdout.
   */
  async listCsv(params: P = {} as P): Promise<RawResponse> {
    return this.e.getRaw(this.path, CSV_ACCEPT, { ...this.listQuery(params), format: "csv" });
  }

  /**
   * One object by id. The id must be a non-negative integer or a digit string;
   * anything else rejects with an FdsValidationError before any request.
   */
  async get(id: number | string): Promise<JsonObject> {
    return this.e.getJson(`${this.path}${normalizeResourceId(id)}/`);
  }
}

/** FOI requests, plus full-text search and tag autocomplete. */
class RequestResource extends ListResource<FoiRequestListItem, RequestListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/request/", REQUEST_LIST_RULES);
  }

  /** Full-text / faceted search over public requests. */
  search(params: RequestSearchParams = {}): Promise<TastypieList<FoiRequestListItem>> {
    return this.e.getJson("/api/v1/request/search/", params as QueryParams);
  }

  /** The full-text request search as server-rendered CSV. */
  searchCsv(params: RequestSearchParams = {}): Promise<RawResponse> {
    return this.e.getRaw("/api/v1/request/search/", CSV_ACCEPT, {
      ...(params as QueryParams),
      format: "csv",
    });
  }

  /** Autocomplete request tags. */
  tagsAutocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/request/tags/autocomplete/", { ...page, q } as QueryParams);
  }
}

/** Public bodies, plus full-text search and name autocomplete. */
class PublicBodyResource extends ListResource<PublicBodyListItem, PublicBodyListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/publicbody/");
  }

  /** Full-text search over public bodies. */
  search(params: PublicBodySearchParams = {}): Promise<TastypieList<PublicBodyListItem>> {
    return this.e.getJson("/api/v1/publicbody/search/", params as QueryParams);
  }

  /** The public-body search as server-rendered CSV. */
  searchCsv(params: PublicBodySearchParams = {}): Promise<RawResponse> {
    return this.e.getRaw("/api/v1/publicbody/search/", CSV_ACCEPT, {
      ...(params as QueryParams),
      format: "csv",
    });
  }

  /** Autocomplete public-body names. */
  autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/publicbody/autocomplete/", { ...page, q } as QueryParams);
  }
}

/** FOI laws, plus name autocomplete. */
class LawResource extends ListResource<FoiLawListItem, LawListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/law/", LAW_LIST_RULES);
  }

  autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/law/autocomplete/", { ...page, q } as QueryParams);
  }
}

/** Topical categories (a tree), plus name autocomplete. */
class CategoryResource extends ListResource<CategoryListItem, TreeListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/category/", TREE_LIST_RULES);
  }

  autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/category/autocomplete/", { ...page, q } as QueryParams);
  }
}

/** Geographic regions, plus name autocomplete. */
class GeoRegionResource extends ListResource<GeoRegionListItem, GeoRegionListParams> {
  constructor(e: RequestEngine) {
    super(e, "/api/v1/georegion/", GEOREGION_LIST_RULES);
  }

  autocomplete(q: string, page: Pagination = {}): Promise<TastypieList<AutocompleteItem>> {
    return this.e.getJson("/api/v1/georegion/autocomplete/", { ...page, q } as QueryParams);
  }
}

export class FragDenStaatClient {
  private readonly engine: RequestEngine;

  readonly requests: RequestResource;
  readonly publicBodies: PublicBodyResource;
  readonly laws: LawResource;
  readonly jurisdictions: ListResource<JurisdictionListItem>;
  readonly categories: CategoryResource;
  readonly classifications: ListResource<ClassificationListItem, TreeListParams>;
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
    this.classifications = new ListResource(this.engine, "/api/v1/classification/", TREE_LIST_RULES);
    this.campaigns = new ListResource(this.engine, "/api/v1/campaign/");
    this.messages = new ListResource(this.engine, "/api/v1/message/", MESSAGE_LIST_RULES);
    this.documents = new ListResource(this.engine, "/api/v1/document/");
    this.georegions = new GeoRegionResource(this.engine);
  }
}
