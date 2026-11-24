// The use cases of the skills as library functions, built on the resources: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them:
// - findPublicBody (fds-authority-lookup): a body by name, or bodies by topic and place;
// - findRequests (fds-request-finder): FOI requests by full text or by facets;
// - getRequestOutcomes (fds-request-finder): how resolved requests went, counted per resolution;
// - findDocuments (fds-document-digger): released documents by authority, request, tag, campaign;
// - findLaws (fds-law-explorer): the FOI laws of a jurisdiction or a town, one law in full;
// and three generic ones: getRequest (a request with its messages), getDocument (a document with
// its pages' text) and searchReference (the names and ids the filters take).
//
// The rules they share:
// - names are resolved to the ids (or the exact names, or the slugs) each endpoint takes;
// - ambiguity is reported, never guessed: a name that fits several is `ambiguous`, with them;
// - no bare "not found": an empty answer says what was searched and what to change;
// - every request an answer made is kept (`requestsOf(answer)`), for the answer's source.
// Each result type is public API of the CLI package: a changed shape is a `feat(client)!:` commit.

import type { FragDenStaatClient } from "./client.js";
import type { RequestResolution, RequestStatus } from "./enums.js";
import { RequestResolutionValues, RequestStatusValues } from "./enums.js";
import { FdsApiError, FdsParseError, FdsValidationError, quoteValue } from "./errors.js";
import {
  assertParams,
  CATEGORY_LIST_PARAMS,
  CLASSIFICATION_LIST_PARAMS,
  DOCUMENT_LIST_PARAMS,
  LAW_LIST_PARAMS,
  PAGE_ONLY_PARAMS,
  PAGINATION_PARAMS,
  PUBLICBODY_LIST_PARAMS,
  PUBLICBODY_SEARCH_PARAMS,
  REQUEST_LIST_PARAMS,
  REQUEST_SEARCH_PARAMS,
  type ParamSpec,
} from "./filters.js";
import { MAX_PAGE_SIZE } from "./params.js";
import type { DocumentListParams, LawListParams, Pagination, PublicBodyListParams, PublicBodySearchParams, RequestListParams, RequestSearchParams } from "./params.js";
import { buildQueryString, type QueryParams } from "./query.js";
import type { JsonObject, JsonValue, TastypieList } from "./types.js";
import { assertValid, normalizeResourceId, normalizeText, textProblem } from "./validate.js";

// ---------------------------------------------------------------------------------------------
// The requests an answer made

const REQUESTS = new WeakMap<object, readonly string[]>();

/**
 * The requests (path and query, no host) the operation that returned `answer` made, in order:
 * what its `source` names. Empty for an object no operation returned.
 */
export function requestsOf(answer: object): readonly string[] {
  return REQUESTS.get(answer) ?? [];
}

/**
 * `page` when its rows are records and it sends rows wherever its total says there are some: a page
 * that counts rows past `offset` but sends none, or sends a row that isn't an object, is an upstream
 * fault (an FdsParseError), never "nothing matched" or an internal error.
 */
function checkedPage<T>(path: string, offset: number, page: TastypieList<T>): TastypieList<T> {
  const bad = page.objects.findIndex((row) => row === null || typeof row !== "object" || Array.isArray(row));
  if (bad >= 0) throw new FdsParseError(`The API's answer to ${path} is malformed: row ${offset + bad + 1} isn't a record (${row(page.objects[bad])}).`);
  const total = page.meta.total_count;
  if (page.objects.length === 0 && total > offset) throw new FdsParseError(`The API's answer to ${path} is malformed: it counts ${total} from offset ${offset} on but sends none.`);
  return page;
}

const row = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "a list" : typeof value);

/** What every operation takes besides its input. */
export interface OperationOptions {
  /**
   * The most pages of 50 an operation reads of one list it reads whole (the jurisdictions, the
   * campaigns, a law's siblings, a request's documents), per list and call: 1 to 100, default 10.
   * A list cut there is said so in the answer.
   */
  maxPages?: number | undefined;
}

/** The default of {@link OperationOptions.maxPages}. */
export const DEFAULT_MAX_PAGES = 10;

/** A list read page by page: its rows, its total and whether all of them were read. */
interface WholeList<T> {
  objects: T[];
  total: number;
  complete: boolean;
}

/** The requests of one operation call, recorded as the client sends them. */
class Trace {
  readonly paths: string[] = [];
  readonly maxPages: number;

  constructor(
    private readonly client: FragDenStaatClient,
    options: OperationOptions = {},
  ) {
    this.maxPages = assertValid("maxPages", options?.maxPages ?? DEFAULT_MAX_PAGES, (v: number) => (Number.isSafeInteger(v) && v >= 1 && v <= 100 ? undefined : "Expected a whole number from 1 to 100."));
  }

  /** Every row of a list, a page of 50 at a time, up to maxPages pages. */
  async all<T>(path: string, spec: ParamSpec, params: object, call: (params: never) => Promise<TastypieList<T>>): Promise<WholeList<T>> {
    const objects: T[] = [];
    let total = 0;
    for (let n = 0; n < this.maxPages; n++) {
      const offset = objects.length;
      const page = await this.list(path, spec, { ...params, ...(offset === 0 ? {} : { offset }), limit: MAX_PAGE_SIZE }, call);
      total = page.meta.total_count;
      objects.push(...page.objects);
      if (page.objects.length === 0 || objects.length >= total) break;
    }
    return { objects, total, complete: objects.length >= total };
  }

  /** `answer`, with this call's requests kept for `requestsOf`. */
  done<T extends object>(answer: T): T {
    REQUESTS.set(answer, [...this.paths]);
    return answer;
  }

  private note(path: string, query: QueryParams): void {
    const qs = buildQueryString(query);
    this.paths.push(qs === "" ? path : `${path}?${qs}`);
  }

  async list<T>(
    path: string,
    spec: ParamSpec,
    params: object,
    call: (params: never) => Promise<TastypieList<T>>,
  ): Promise<TastypieList<T>> {
    const query = assertParams(params, spec);
    this.note(path, query);
    return checkedPage(path, Number(query["offset"] ?? 0), await call(params as never));
  }

  async get(path: string, id: number | string, call: (id: string) => Promise<JsonObject>): Promise<JsonObject> {
    const key = normalizeResourceId(id);
    this.note(`${path}${key}/`, {});
    return call(key);
  }

  async autocomplete(path: string, q: string, page: Pagination, call: (q: string, page: Pagination) => Promise<TastypieList<{ value: number | string; label: string }>>) {
    const query = assertParams(page, PAGINATION_PARAMS);
    this.note(path, { ...query, q: normalizeText(q) });
    return checkedPage(path, Number(query["offset"] ?? 0), await call(q, page));
  }

  get api(): FragDenStaatClient {
    return this.client;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared shapes and helpers

/** Something the filters name: its id, its name and, where it has one, its slug. */
export interface Ref {
  id: number;
  name: string;
  slug?: string;
}

/** What a name fitted when it fitted several: the input's name and the candidates. */
export interface Ambiguity {
  /** The input whose value fits several (`jurisdiction`, `publicBody`, `name`, …). */
  field: string;
  value: string;
  candidates: Ref[];
  /** How many fit in all (candidates holds the first ones). */
  total: number;
}

/** A filter value resolved, fitting several, or fitting none (with why). */
type Resolution<T> = { ref: T } | { ambiguous: Ambiguity } | { none: string };

/** The answers a resolution step ends a call with. */
export type NotResolved =
  | { status: "ambiguous"; searched: Record<string, unknown>; ambiguous: Ambiguity; reason: string }
  | { status: "empty"; searched: Record<string, unknown>; reason: string };

/** The platform's hosts: fragdenstaat.de and frag-den-staat.de (media.frag-den-staat.de), with their subdomains. */
const PLATFORM_HOST = /(?:^|\.)(?:fragdenstaat|frag-den-staat)\.de$/;

/**
 * A link to the platform's page or file: an https URL on its hosts (a path is resolved against
 * fragdenstaat.de), else null. Upstream text is data, and a client renders a link as one: a
 * `javascript:` or `data:` URL, or a page on another host, is never passed on as the record's.
 */
function platformLink(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value, "https://fragdenstaat.de/");
    return url.protocol === "https:" && url.username === "" && url.password === "" && PLATFORM_HOST.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/** A link to a body's own website: an absolute http or https URL on any host, else null. */
function webLink(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

/** The numeric id at the end of a resource URI (`…/api/v1/law/124/` → 124), or null. */
export function idFromUri(uri: unknown): number | null {
  if (typeof uri === "number" && Number.isSafeInteger(uri)) return uri;
  if (typeof uri !== "string") return null;
  const match = /\/(\d+)\/?(?:[?#].*)?$/.exec(uri);
  return match === null ? null : Number(match[1]);
}

/** A name folded for comparing: case, Unicode form, umlauts (ä = ae), punctuation and dashes aside. */
export function foldName(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The one item whose name (or slug) is `wanted`, else the one with a word that starts it (Anhalt,
 * "baden w"), else several or none. Never a part inside a word: Essen is not Hessen, Berg not
 * Baden-Württemberg, so a town's name isn't taken for a jurisdiction that happens to hold it.
 */
function pick<T>(items: readonly T[], wanted: string, names: (item: T) => (string | undefined | null)[]): { one: T } | { several: T[] } | { none: true } {
  const want = foldName(wanted);
  const exact = items.filter((item) => names(item).some((name) => typeof name === "string" && foldName(name) === want));
  if (exact.length === 1) return { one: exact[0] as T };
  if (exact.length > 1) return { several: exact };
  const partial = items.filter((item) => names(item).some((name) => typeof name === "string" && ` ${foldName(name)}`.includes(` ${want}`)));
  if (partial.length === 1) return { one: partial[0] as T };
  if (partial.length > 1) return { several: partial };
  return { none: true };
}

/**
 * True for the API's own "not found": a 404 with its JSON error body (`{"detail": "Nicht
 * gefunden."}`). Any other 404 (an HTML page from a proxy, a base URL with the wrong path) is a
 * failure of the service, not an answer about the record, and is thrown on.
 */
function isApiNotFound(err: unknown): boolean {
  if (!(err instanceof FdsApiError) || err.status !== 404) return false;
  try {
    const body: unknown = JSON.parse(err.body);
    return body !== null && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>)["detail"] === "string";
  } catch {
    return false;
  }
}

const isDigits = (value: string): boolean => /^\d{1,12}$/.test(value);
const str = (value: JsonValue | undefined): string | null => (typeof value === "string" ? value : null);
const num = (value: JsonValue | undefined): number | null => (typeof value === "number" ? value : null);
const obj = (value: JsonValue | undefined): JsonObject | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

/** `text` cut to `max` characters, with an ellipsis when cut. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** A checked, trimmed text input, or undefined when not given. */
function textInput(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeText(assertValid(name, value, textProblem));
}

/** A checked page size (1–max, default `fallback`). */
function pageSize(value: number | undefined, fallback: number, max = MAX_PAGE_SIZE): number {
  return assertValid("limit", value ?? fallback, (v: number) => (Number.isSafeInteger(v) && v >= 1 && v <= max ? undefined : `Expected a whole number from 1 to ${max}.`));
}

/** A checked offset (0 or more, default 0). */
function pageStart(value: number | undefined): number {
  return assertValid("offset", value ?? 0, (v: number) => (Number.isSafeInteger(v) && v >= 0 ? undefined : "Expected a whole number of 0 or more."));
}

/** Text segments (`[[isRedacted, text], …]`) as one text; the redacted parts are already marked. */
function redactedText(segments: JsonValue | undefined, fallback: JsonValue | undefined): string {
  if (Array.isArray(segments) && segments.length > 0) {
    return segments.map((segment) => (Array.isArray(segment) && typeof segment[1] === "string" ? segment[1] : "")).join("");
  }
  return typeof fallback === "string" ? fallback : "";
}

/** The answer a filter value that fits several ends a call with. */
function ambiguousAnswer(searched: Record<string, unknown>, ambiguous: Ambiguity): NotResolved {
  return {
    status: "ambiguous",
    searched,
    ambiguous,
    reason: `${quoteValue(ambiguous.value)} fits ${ambiguous.total} for ${ambiguous.field}: ask which one, then call again with its id.`,
  };
}

/** The answer of a resolution that didn't resolve. */
function unresolved(searched: Record<string, unknown>, resolution: { ambiguous: Ambiguity } | { none: string }): NotResolved {
  return "ambiguous" in resolution ? ambiguousAnswer(searched, resolution.ambiguous) : { status: "empty", searched, reason: resolution.none };
}

const refOf = (item: { id: number; name: string; slug?: string }): Ref => ({ id: item.id, name: item.name, ...(item.slug === undefined ? {} : { slug: item.slug }) });

/** Several matches as an ambiguity of `field`. */
function several(field: string, value: string, items: readonly Ref[]): { ambiguous: Ambiguity } {
  return { ambiguous: { field, value, candidates: items.slice(0, 20), total: items.length } };
}

// ---------------------------------------------------------------------------------------------
// Name → id resolvers

/** What a list cut at maxPages leaves out, for a reason or a note ("" for a list read whole). */
function cutNote(list: WholeList<unknown>, what: string): string {
  return list.complete ? "" : ` Only the first ${list.objects.length} of ${list.total} ${what} were read (maxPages).`;
}

/** The jurisdictions, all of them (18: one request). */
async function jurisdictionsOf(t: Trace): Promise<WholeList<Ref>> {
  const list = await t.all("/api/v1/jurisdiction/", PAGE_ONLY_PARAMS, {}, (p) => t.api.jurisdictions.list(p));
  return { ...list, objects: list.objects.map(refOf) };
}

/** A jurisdiction by id, name or slug ("Bayern", "nrw", 92): from the list of all 18. */
async function resolveJurisdiction(t: Trace, value: string): Promise<Resolution<Ref>> {
  const list = await jurisdictionsOf(t);
  const refs = list.objects;
  const cut = cutNote(list, "jurisdictions");
  if (isDigits(value)) {
    const found = refs.find((ref) => ref.id === Number(value));
    return found === undefined ? { none: `No jurisdiction has the id ${value}. The jurisdictions: ${refs.map((r) => `${r.name} (${r.id})`).join(", ")}.${cut}` } : { ref: found };
  }
  const match = pick(refs, value, (ref) => [ref.name, ref.slug]);
  if ("one" in match) return { ref: match.one };
  if ("several" in match) return several("jurisdiction", value, match.several);
  return { none: `No jurisdiction is named ${quoteValue(value)}. The jurisdictions: ${refs.map((r) => `${r.name} (${r.id})`).join(", ")}. A town or district is no jurisdiction: its local statutes have none (search them by the town's name).${cut}` };
}

/** A category or classification by id or name, from its list's `q` search. */
async function resolveTaxonomy(t: Trace, kind: "category" | "classification", value: string): Promise<Resolution<Ref>> {
  const path = kind === "category" ? "/api/v1/category/" : "/api/v1/classification/";
  const resource = kind === "category" ? t.api.categories : t.api.classifications;
  if (isDigits(value)) {
    try {
      const item = await t.get(path, value, (id) => resource.get(id));
      return { ref: { id: Number(item["id"]), name: String(item["name"]), ...(typeof item["slug"] === "string" ? { slug: item["slug"] } : {}) } };
    } catch (err) {
      if (isApiNotFound(err)) return { none: `No ${kind} has the id ${value}. Look it up by name (searchReference).` };
      throw err;
    }
  }
  const spec = kind === "category" ? CATEGORY_LIST_PARAMS : CLASSIFICATION_LIST_PARAMS;
  const items = (await t.list(path, spec, { q: value, limit: MAX_PAGE_SIZE }, (p) => resource.list(p))).objects.map(refOf);
  const match = pick(items, value, (ref) => [ref.name, ref.slug]);
  if ("one" in match) return { ref: match.one };
  if ("several" in match) return several(kind, value, match.several);
  return { none: `No ${kind} is named ${quoteValue(value)}. ${kind === "category" ? "Categories are topics (Umwelt, Digitales, Verkehr)" : "Classifications are types of body (Ministerium, Polizei, Grundschule)"}; look one up with searchReference.` };
}

/**
 * A public body by id or name: the id as given; a name through the autocomplete, which searches
 * the names only (as parts: "UBA" fits Laubach and the Bremer Aufbaubank, not the UBA). So when no
 * name is the value exactly, the full-text search, which also holds the bodies' other names (UBA,
 * BMVg, Verteidigungsministerium), is asked for a body whose other name it is; only then is a single
 * part-of-name hit taken.
 */
async function resolvePublicBody(t: Trace, value: string, field = "publicBody"): Promise<Resolution<Ref>> {
  if (isDigits(value)) return { ref: { id: Number(value), name: "" } };
  const want = foldName(value);
  const hits = await t.autocomplete("/api/v1/publicbody/autocomplete/", value, { limit: MAX_PAGE_SIZE }, (q, page) => t.api.publicBodies.autocomplete(q, page));
  const refs = hits.objects.filter((hit) => typeof hit.value === "number").map((hit) => ({ id: hit.value as number, name: hit.label }));
  const exact = refs.filter((ref) => foldName(ref.name) === want);
  if (exact.length === 1) return { ref: exact[0] as Ref };
  if (exact.length === 0) {
    const found = await t.list("/api/v1/publicbody/search/", PUBLICBODY_SEARCH_PARAMS, { q: value, limit: MAX_PAGE_SIZE }, (p) => t.api.publicBodies.search(p));
    const named = (found.objects as unknown as JsonObject[])
      .filter((body) => (str(body["other_names"]) ?? "").split(/[,;]/).some((other) => foldName(other) === want))
      .map((body) => ({ id: num(body["id"]) ?? 0, name: str(body["name"]) ?? "" }));
    if (named.length === 1) return { ref: named[0] as Ref };
    if (named.length > 1) return { ambiguous: { field, value, candidates: named.slice(0, 20), total: named.length } };
  }
  if (refs.length === 1) return { ref: refs[0] as Ref };
  if (refs.length > 1) return { ambiguous: { field, value, candidates: [...exact, ...refs.filter((r) => !exact.includes(r))].slice(0, 20), total: hits.meta.total_count } };
  return { none: `No public body's name or other name holds ${quoteValue(value)}. Try a shorter part of the name, or search by topic and place (findPublicBody with query and jurisdiction).` };
}

/** A request tag by its name: the exact one (case-sensitive), else the one equal but for case. */
async function resolveTag(t: Trace, value: string): Promise<Resolution<string> & { note?: string }> {
  const hits = await t.autocomplete("/api/v1/request/tags/autocomplete/", value, { limit: MAX_PAGE_SIZE }, (q, page) => t.api.requests.tagsAutocomplete(q, page));
  const names = hits.objects.map((hit) => String(hit.value));
  if (names.includes(value)) return { ref: value };
  const folded = names.filter((name) => foldName(name) === foldName(value));
  if (folded.length === 1) return { ref: folded[0] as string, note: `The tag is ${quoteValue(folded[0] as string)} (tags match exactly, case-sensitive).` };
  if (names.length === 0) return { none: `No request tag holds ${quoteValue(value)}. Tags match exactly; search the words with query instead (full text), or try another word.` };
  return { none: `No request tag is exactly ${quoteValue(value)} (tags match exactly, case-sensitive). Tags holding it: ${names.slice(0, 15).map((n) => quoteValue(n)).join(", ")}${names.length > 15 ? ", …" : ""}.` };
}

/** A campaign by id or name: from the list of all (about 18: one request). */
async function resolveCampaign(t: Trace, value: string): Promise<Resolution<Ref>> {
  const list = await t.all("/api/v1/campaign/", PAGE_ONLY_PARAMS, {}, (p) => t.api.campaigns.list(p));
  const all = list.objects.map(refOf);
  const cut = cutNote(list, "campaigns");
  if (isDigits(value)) {
    const found = all.find((ref) => ref.id === Number(value));
    return found === undefined ? { none: `No campaign has the id ${value}. The campaigns: ${all.map((r) => `${r.name} (${r.id})`).join(", ")}.${cut}` } : { ref: found };
  }
  const match = pick(all, value, (ref) => [ref.name, ref.slug]);
  if ("one" in match) return { ref: match.one };
  if ("several" in match) return several("campaign", value, match.several);
  return { none: `No campaign is named ${quoteValue(value)}. The campaigns: ${all.map((r) => `${r.name} (${r.id})`).join(", ")}.${cut}` };
}

// ---------------------------------------------------------------------------------------------
// Rows

/** A public body as a list row. */
export interface PublicBodyRow {
  id: number;
  name: string;
  classification: string | null;
  jurisdiction: string | null;
  email: string | null;
  /** How the body wants to be contacted, cut to 300 characters (getting the body gives it whole). */
  requestNote: string | null;
  numberOfRequests: number | null;
  siteUrl: string | null;
}

function nameOf(value: JsonValue | undefined): string | null {
  const o = obj(value);
  return o !== null && typeof o["name"] === "string" ? o["name"] : null;
}

function publicBodyRow(body: JsonObject): PublicBodyRow {
  const note = str(body["request_note"]) ?? "";
  return {
    id: num(body["id"]) ?? 0,
    name: str(body["name"]) ?? "",
    classification: nameOf(body["classification"]),
    jurisdiction: nameOf(body["jurisdiction"]),
    email: str(body["email"]) || null,
    requestNote: note === "" ? null : cut(note, 300),
    numberOfRequests: num(body["number_of_requests"]),
    siteUrl: platformLink(body["site_url"]),
  };
}

/** A request as a list row. */
export interface RequestRow {
  id: number;
  title: string;
  status: string;
  readableStatus: string | null;
  /** The outcome; null while the request isn't resolved (the API's "" then means nothing). */
  resolution: string | null;
  publicBody: { id: number; name: string } | null;
  jurisdiction: string | null;
  lawId: number | null;
  costs: number | null;
  createdAt: string | null;
  /** The latest message: the closest thing to a closing date (resolved_on is not filled). */
  lastMessage: string | null;
  dueDate: string | null;
  tags: string[];
  url: string | null;
}

function requestRow(request: JsonObject): RequestRow {
  const body = obj(request["public_body"]);
  const status = str(request["status"]) ?? "";
  return {
    id: num(request["id"]) ?? 0,
    title: str(request["title"]) ?? "",
    status,
    readableStatus: str(request["readable_status"]),
    resolution: status === "resolved" && str(request["resolution"]) ? (request["resolution"] as string) : null,
    publicBody: body === null ? null : { id: num(body["id"]) ?? 0, name: str(body["name"]) ?? "" },
    jurisdiction: str(request["jurisdiction_name"]),
    lawId: idFromUri(request["law"]) ?? num(obj(request["law"])?.["id"]),
    costs: num(request["costs"]),
    createdAt: str(request["created_at"]),
    lastMessage: str(request["last_message"]),
    dueDate: str(request["due_date"]),
    tags: arr(request["tags"]).filter((tag): tag is string => typeof tag === "string"),
    url: platformLink(request["url"]),
  };
}

/** A document as a list row. */
export interface DocumentRow {
  id: number;
  title: string;
  description: string | null;
  requestId: number | null;
  publicBodyId: number | null;
  numPages: number | null;
  /** The file on the server: metadata only, nothing is downloaded. */
  fileUrl: string | null;
  fileSize: number | null;
  siteUrl: string | null;
  /** When the document last changed (published_at is usually empty). */
  lastModifiedAt: string | null;
  author: string | null;
}

function documentRow(document: JsonObject): DocumentRow {
  const description = str(document["description"]) ?? "";
  return {
    id: num(document["id"]) ?? 0,
    title: str(document["title"]) ?? "",
    description: description === "" ? null : cut(description, 300),
    requestId: idFromUri(document["foirequest"]),
    publicBodyId: idFromUri(document["publicbody"]),
    numPages: num(document["num_pages"]),
    fileUrl: platformLink(document["file_url"]),
    fileSize: num(document["file_size"]),
    siteUrl: platformLink(document["site_url"]),
    lastModifiedAt: str(document["last_modified_at"]),
    author: str(obj(document["properties"])?.["author"]),
  };
}

/** The response deadline, with its unit in words: a number alone means nothing. */
export interface Deadline {
  value: number | null;
  /** The API's unit (month_de, working_day, day, …). */
  unit: string;
  /** In words: "1 calendar month", "20 working days". */
  text: string;
}

const UNIT_WORDS: Record<string, [string, string]> = {
  month_de: ["calendar month", "calendar months"],
  month: ["month", "months"],
  working_day: ["working day", "working days"],
  day: ["day", "days"],
  week: ["week", "weeks"],
};

/** The deadline of a law, in words. */
export function deadlineOf(value: JsonValue | undefined, unit: JsonValue | undefined): Deadline {
  const n = num(value);
  const u = str(unit) ?? "";
  const words = UNIT_WORDS[u];
  const text = n === null ? "no deadline set" : words === undefined ? `${n} ${u}` : `${n} ${n === 1 ? words[0] : words[1]}${u === "month_de" ? " (counted as German calendar months)" : ""}`;
  return { value: n, unit: u, text };
}

/** A law as a list row. */
export interface LawRow {
  id: number;
  name: string;
  lawType: string | null;
  /** The jurisdiction's name; null for a local statute (Satzung), which has none. */
  jurisdiction: string | null;
  jurisdictionId: number | null;
  meta: boolean;
  deadline: Deadline;
  requiresSignature: boolean;
  hasLegalText: boolean;
  siteUrl: string | null;
}

function lawRow(law: JsonObject, jurisdictions: ReadonlyMap<number, string>): LawRow {
  const jid = idFromUri(law["jurisdiction"]) ?? num(obj(law["jurisdiction"])?.["id"]);
  return {
    id: num(law["id"]) ?? 0,
    name: str(law["name"]) ?? "",
    lawType: str(law["law_type"]) || null,
    jurisdiction: jid === null ? null : (jurisdictions.get(jid) ?? null),
    jurisdictionId: jid,
    meta: law["meta"] === true,
    deadline: deadlineOf(law["max_response_time"], law["max_response_time_unit"]),
    requiresSignature: law["requires_signature"] === true,
    hasLegalText: (str(law["legal_text"]) ?? "") !== "",
    siteUrl: platformLink(law["site_url"]),
  };
}

/** The search endpoints count at most this many hits: a total of it means "at least". */
export const SEARCH_TOTAL_CAP = 10_000;

// ---------------------------------------------------------------------------------------------
// findPublicBody (fds-authority-lookup)

/** The input of {@link findPublicBody}: a `name`, or a search by topic and place. */
export interface FindPublicBodyInput {
  /** The body's name, part of it or its id (Umweltbundesamt, UBA, 875): its full profile. */
  name?: string | undefined;
  /** Full text: what the body does (Umwelt, Bauaufsicht). */
  query?: string | undefined;
  /** Bund, a Land or the EU: name, slug or id. */
  jurisdiction?: string | undefined;
  /** The type of body (Ministerium, Grundschule): the whole subtree below it. Name or id. */
  classification?: string | undefined;
  /** A topical category (Umwelt, Digitales): name or id. */
  category?: string | undefined;
  /** A point `lng,lat` (longitude first): bodies whose regions contain it, in name order, not by distance. */
  point?: string | undefined;
  offset?: number | undefined;
  /** Rows per page (1–50, default 20). */
  limit?: number | undefined;
}

/** A public body's full profile. */
export interface PublicBodyProfile {
  id: number;
  name: string;
  otherNames: string | null;
  classification: string | null;
  jurisdiction: Ref | null;
  categories: string[];
  /** The FOI intake address: where a request is sent. */
  email: string | null;
  /** How the body wants to be contacted, verbatim; null when it has none. */
  requestNote: string | null;
  contact: string | null;
  address: string | null;
  fax: string | null;
  url: string | null;
  siteUrl: string | null;
  /** An activity signal, not a promise of answers. */
  numberOfRequests: number | null;
  laws: { id: number; name: string; meta: boolean }[];
  parentId: number | null;
}

/** The answer of {@link findPublicBody}. */
export type PublicBodyLookup =
  | { status: "ok"; searched: Record<string, unknown>; body: PublicBodyProfile; notes: string[] }
  | { status: "ok"; searched: Record<string, unknown>; total: number; totalIsLowerBound: boolean; offset: number; bodies: PublicBodyRow[]; duplicatesDropped: number; nextOffset?: number; notes: string[] }
  | NotResolved;

function profileOf(body: JsonObject): PublicBodyProfile {
  const jurisdiction = obj(body["jurisdiction"]);
  const note = str(body["request_note"]) ?? "";
  return {
    id: num(body["id"]) ?? 0,
    name: str(body["name"]) ?? "",
    otherNames: str(body["other_names"]) || null,
    classification: nameOf(body["classification"]),
    jurisdiction: jurisdiction === null ? null : { id: num(jurisdiction["id"]) ?? 0, name: str(jurisdiction["name"]) ?? "" },
    categories: arr(body["categories"]).map((c) => nameOf(c) ?? (typeof c === "string" ? c : null)).filter((c): c is string => c !== null),
    email: str(body["email"]) || null,
    requestNote: note === "" ? null : note,
    contact: str(body["contact"]) || null,
    address: str(body["address"])?.replace(/\r\n/g, "\n") || null,
    fax: str(body["fax"]) || null,
    url: webLink(body["url"]),
    siteUrl: platformLink(body["site_url"]),
    numberOfRequests: num(body["number_of_requests"]),
    laws: arr(body["laws"]).map(obj).filter((l): l is JsonObject => l !== null).map((l) => ({ id: num(l["id"]) ?? 0, name: str(l["name"]) ?? "", meta: l["meta"] === true })),
    parentId: idFromUri(body["parent"]),
  };
}

/**
 * A public body (Behörde) to address an FOI request to. With `name`: one body's full profile
 * (its FOI email and request note first); a name that fits several is `ambiguous`. Without it: the
 * bodies matching a topic (`query`, full text) and place (`jurisdiction`, `classification`,
 * `category`, `point`), each name resolved to the id the endpoint takes first. A point keeps the
 * bodies whose regions contain it, not the nearest; a body found through several regions is
 * listed once.
 */
export async function findPublicBody(client: FragDenStaatClient, input: FindPublicBodyInput, options: OperationOptions = {}): Promise<PublicBodyLookup> {
  const t = new Trace(client, options);
  const name = textInput("name", input.name);
  const query = textInput("query", input.query);
  const jurisdiction = textInput("jurisdiction", input.jurisdiction);
  const classification = textInput("classification", input.classification);
  const category = textInput("category", input.category);
  const point = textInput("point", input.point);
  const limit = pageSize(input.limit, 20);
  const offset = pageStart(input.offset);
  if (name !== undefined) {
    if ([query, jurisdiction, classification, category, point].some((v) => v !== undefined)) {
      throw new FdsValidationError("Invalid input: name looks one body up; query, jurisdiction, classification, category and point search for bodies. Give one or the other.");
    }
    const searched = { name };
    const resolved = await resolvePublicBody(t, name, "name");
    if (!("ref" in resolved)) return t.done(unresolved(searched, resolved));
    let detail: JsonObject;
    try {
      detail = await t.get("/api/v1/publicbody/", resolved.ref.id, (id) => client.publicBodies.get(id));
    } catch (err) {
      if (isApiNotFound(err)) return t.done({ status: "empty", searched, reason: `No public body has the id ${resolved.ref.id}. Look the body up by its name.` });
      throw err;
    }
    const body = profileOf(detail);
    const notes = [
      body.requestNote === null ? "The body has no request note: nothing special is asked for." : "Quote the request note verbatim: it says how the body wants to be contacted.",
      body.email === null ? "No FOI email is on file: point to the body's page (siteUrl)." : "email is the FOI intake address.",
      `For its track record: getRequestOutcomes or findRequests with publicBody ${body.id}.`,
    ];
    return t.done({ status: "ok", searched, body, notes });
  }
  if ([query, jurisdiction, classification, category, point].every((v) => v === undefined)) {
    throw new FdsValidationError("Invalid input: give a name, or what to search by (query, jurisdiction, classification, category or point).");
  }
  if (point !== undefined && !/^-?\d{1,3}(\.\d+)?,\s*-?\d{1,2}(\.\d+)?$/.test(point)) {
    throw new FdsValidationError(`Invalid point: ${quoteValue(point)} is not "lng,lat" (longitude first, e.g. 11.5755,48.1372 for Munich).`);
  }
  const searched: Record<string, unknown> = {};
  if (query !== undefined) searched["query"] = query;
  let jurisdictionRef: Ref | undefined;
  let classificationRef: Ref | undefined;
  let categoryRef: Ref | undefined;
  if (jurisdiction !== undefined) {
    const r = await resolveJurisdiction(t, jurisdiction);
    if (!("ref" in r)) return t.done(unresolved({ ...searched, jurisdiction }, r));
    jurisdictionRef = r.ref;
    searched["jurisdiction"] = r.ref;
  }
  if (classification !== undefined) {
    const r = await resolveTaxonomy(t, "classification", classification);
    if (!("ref" in r)) return t.done(unresolved({ ...searched, classification }, r));
    classificationRef = r.ref;
    searched["classification"] = r.ref;
  }
  if (category !== undefined) {
    const r = await resolveTaxonomy(t, "category", category);
    if (!("ref" in r)) return t.done(unresolved({ ...searched, category }, r));
    categoryRef = r.ref;
    searched["category"] = r.ref;
  }
  if (point !== undefined) searched["point"] = point;
  const notes: string[] = [];
  let page: TastypieList<JsonObject>;
  let capped = false;
  if (query !== undefined && point === undefined) {
    // The full-text search: its category is the plural `categories`, an id.
    const params: PublicBodySearchParams = { q: query, jurisdiction: jurisdictionRef?.id, classification: classificationRef?.id, categories: categoryRef?.id, offset, limit };
    page = (await t.list("/api/v1/publicbody/search/", PUBLICBODY_SEARCH_PARAMS, params, (p) => client.publicBodies.search(p))) as unknown as TastypieList<JsonObject>;
    capped = page.meta.total_count >= SEARCH_TOTAL_CAP;
  } else {
    // The faceted list: its category is the singular `category`; the point is lng,lat.
    const params: PublicBodyListParams = { q: query, jurisdiction: jurisdictionRef?.id, classification: classificationRef?.id, category: categoryRef?.id, lnglat: point?.replace(/\s+/g, ""), offset, limit };
    page = (await t.list("/api/v1/publicbody/", PUBLICBODY_LIST_PARAMS, params, (p) => client.publicBodies.list(p))) as unknown as TastypieList<JsonObject>;
  }
  const seen = new Set<number>();
  const bodies: PublicBodyRow[] = [];
  for (const body of page.objects) {
    const row = publicBodyRow(body);
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    bodies.push(row);
  }
  const total = page.meta.total_count;
  if (bodies.length === 0) {
    const reason =
      offset > 0 && total > 0
        ? `The search found ${total}; offset ${offset} is past the end.`
        : `No public body matched ${JSON.stringify(searched)}. Drop a filter, or use a broader word (query), or another classification (its whole subtree is searched).`;
    return t.done({ status: "empty", searched, reason });
  }
  if (classificationRef !== undefined) notes.push(`classification ${classificationRef.name} covers its whole subtree of types.`);
  if (point !== undefined) notes.push("Bodies whose regions contain the point, in name order: not the nearest. Land-wide bodies seated elsewhere are included.");
  if (capped) notes.push(`The search counts at most ${SEARCH_TOTAL_CAP} hits: the total means "at least". Narrow the search.`);
  const next = offset + page.objects.length;
  return t.done({
    status: "ok",
    searched,
    total,
    totalIsLowerBound: capped,
    offset,
    bodies,
    duplicatesDropped: page.objects.length - bodies.length,
    ...(next < total && page.objects.length > 0 ? { nextOffset: next } : {}),
    notes,
  });
}

// ---------------------------------------------------------------------------------------------
// findRequests and getRequestOutcomes (fds-request-finder)

/** The facets a request list is filtered by (names are resolved first). */
export interface RequestFilters {
  /** Bund, a Land or the EU: name, slug or id. */
  jurisdiction?: string | undefined;
  /** An FOI law's id (findLaws gives it). */
  law?: number | string | undefined;
  /** The addressed body: its id or name. */
  publicBody?: string | undefined;
  /** The addressed body's category, by name (Umwelt): matched by its exact name. */
  category?: string | undefined;
  /** The addressed body's type, by name (Ministerium): matched by its exact name. */
  classification?: string | undefined;
  /** One tag's name (Videoüberwachung): matched exactly. */
  tag?: string | undefined;
  /** A campaign: name or id. */
  campaign?: string | undefined;
  /** Filed on or after this day (YYYY-MM-DD). */
  createdAfter?: string | undefined;
  /** Filed on or before this day (YYYY-MM-DD). */
  createdBefore?: string | undefined;
  /** Charged costs at least this many euros. */
  costsMin?: number | undefined;
  /** Charged costs at most this many euros. */
  costsMax?: number | undefined;
}

/** The input of {@link findRequests}: full text (`query`) or the facets. */
export interface FindRequestsInput extends RequestFilters {
  /** Full-text search over the requests; combines only with jurisdiction and category. */
  query?: string | undefined;
  status?: RequestStatus | undefined;
  /** The outcome; implies status resolved. */
  resolution?: RequestResolution | undefined;
  offset?: number | undefined;
  /** Rows per page (1–50, default 20). */
  limit?: number | undefined;
}

/** The answer of {@link findRequests}. */
export type RequestSearch =
  | { status: "ok"; searched: Record<string, unknown>; total: number; totalIsLowerBound: boolean; offset: number; requests: RequestRow[]; nextOffset?: number; notes: string[] }
  | NotResolved;

/** The facets resolved to what the list endpoint takes, or the answer that ends the call. */
async function resolveFilters(t: Trace, filters: RequestFilters): Promise<{ params: RequestListParams; searched: Record<string, unknown>; notes: string[] } | NotResolved> {
  const searched: Record<string, unknown> = {};
  const params: RequestListParams = {};
  const notes: string[] = [];
  const jurisdiction = textInput("jurisdiction", filters.jurisdiction);
  const publicBody = textInput("publicBody", filters.publicBody);
  const category = textInput("category", filters.category);
  const classification = textInput("classification", filters.classification);
  const tag = textInput("tag", filters.tag);
  const campaign = textInput("campaign", filters.campaign);
  if (jurisdiction !== undefined) {
    const r = await resolveJurisdiction(t, jurisdiction);
    if (!("ref" in r)) return unresolved({ ...searched, jurisdiction }, r);
    params.jurisdiction = r.ref.id;
    searched["jurisdiction"] = r.ref;
  }
  if (filters.law !== undefined) {
    params.law = normalizeResourceId(filters.law);
    searched["law"] = Number(params.law);
  }
  if (publicBody !== undefined) {
    const r = await resolvePublicBody(t, publicBody);
    if (!("ref" in r)) return unresolved({ ...searched, publicBody }, r);
    params.public_body = r.ref.id;
    searched["publicBody"] = r.ref.name === "" ? { id: r.ref.id } : r.ref;
  }
  if (category !== undefined) {
    // The list matches the category's exact name: take it as the category list spells it.
    const r = await resolveTaxonomy(t, "category", category);
    if (!("ref" in r)) return unresolved({ ...searched, category }, r);
    params.categories = r.ref.name;
    searched["category"] = r.ref;
  }
  if (classification !== undefined) {
    const r = await resolveTaxonomy(t, "classification", classification);
    if (!("ref" in r)) return unresolved({ ...searched, classification }, r);
    params.classification = r.ref.name;
    searched["classification"] = r.ref;
  }
  if (tag !== undefined) {
    const r = await resolveTag(t, tag);
    if (!("ref" in r)) return unresolved({ ...searched, tag }, r);
    params.tags = r.ref;
    searched["tag"] = r.ref;
    if (r.note !== undefined) notes.push(r.note);
  }
  if (campaign !== undefined) {
    const r = await resolveCampaign(t, campaign);
    if (!("ref" in r)) return unresolved({ ...searched, campaign }, r);
    params.campaign = r.ref.id;
    searched["campaign"] = r.ref;
  }
  if (filters.createdAfter !== undefined) params.created_at_after = searched["createdAfter"] = filters.createdAfter;
  if (filters.createdBefore !== undefined) params.created_at_before = searched["createdBefore"] = filters.createdBefore;
  if (filters.costsMin !== undefined) params.costs_min = searched["costsMin"] = filters.costsMin;
  if (filters.costsMax !== undefined) params.costs_max = searched["costsMax"] = filters.costsMax;
  return { params, searched, notes };
}

const FACETS_ONLY: (keyof FindRequestsInput)[] = ["status", "resolution", "law", "publicBody", "classification", "tag", "campaign", "createdAfter", "createdBefore", "costsMin", "costsMax"];

/**
 * FOI requests: by full text (`query`, the search endpoint: it takes only jurisdiction and
 * category besides, and counts at most 10000 hits) or by the facets (the list endpoint, exact
 * totals). Names are resolved first: a jurisdiction or body to its id, a category or
 * classification to the exact name the list matches, a tag to its exact spelling (a tag that
 * doesn't exist is `empty` with the tags holding the word). A resolution implies status resolved;
 * an open request's resolution is null.
 */
export async function findRequests(client: FragDenStaatClient, input: FindRequestsInput, options: OperationOptions = {}): Promise<RequestSearch> {
  const t = new Trace(client, options);
  const query = textInput("query", input.query);
  const limit = pageSize(input.limit, 20);
  const offset = pageStart(input.offset);
  if (input.status !== undefined) assertValid("status", input.status, (v) => (RequestStatusValues.includes(v) ? undefined : `Allowed choices are ${RequestStatusValues.join(", ")}.`));
  if (input.resolution !== undefined) assertValid("resolution", input.resolution, (v) => (RequestResolutionValues.includes(v) ? undefined : `Allowed choices are ${RequestResolutionValues.join(", ")}.`));
  if (input.status !== undefined && input.resolution !== undefined && input.status !== "resolved") {
    throw new FdsValidationError(`Invalid input: a resolution is set only once a request is resolved, not with status ${input.status}.`);
  }
  if (query !== undefined) {
    const extra = FACETS_ONLY.filter((key) => input[key] !== undefined);
    if (extra.length > 0) {
      throw new FdsValidationError(
        `Invalid input: the full-text search (query) takes only jurisdiction and category; ${extra.join(", ")} need the list. Search first, then filter the list by a tag or body the hits share (without query).`,
      );
    }
    const searched: Record<string, unknown> = { query };
    const params: RequestSearchParams = { q: query };
    const jurisdiction = textInput("jurisdiction", input.jurisdiction);
    const category = textInput("category", input.category);
    if (jurisdiction !== undefined) {
      const r = await resolveJurisdiction(t, jurisdiction);
      if (!("ref" in r)) return t.done(unresolved({ ...searched, jurisdiction }, r));
      params.jurisdiction = r.ref.slug;
      searched["jurisdiction"] = r.ref;
    }
    if (category !== undefined) {
      const r = await resolveTaxonomy(t, "category", category);
      if (!("ref" in r)) return t.done(unresolved({ ...searched, category }, r));
      params.category = r.ref.slug;
      searched["category"] = r.ref;
    }
    params.offset = offset;
    params.limit = limit;
    const page = await t.list("/api/v1/request/search/", REQUEST_SEARCH_PARAMS, params, (p) => client.requests.search(p));
    const capped = page.meta.total_count >= SEARCH_TOTAL_CAP;
    return t.done(requestPage(searched, page as unknown as TastypieList<JsonObject>, offset, capped, capped ? [`The search counts at most ${SEARCH_TOTAL_CAP} hits: the total means "at least".`] : []));
  }
  const resolved = await resolveFilters(t, input);
  if ("status" in resolved) return t.done(resolved);
  const { params, searched, notes } = resolved;
  const status = input.resolution !== undefined ? "resolved" : input.status;
  if (input.resolution !== undefined && input.status === undefined) notes.push("A resolution implies status resolved.");
  const listParams: RequestListParams = { ...(status === undefined ? {} : { status }), ...(input.resolution === undefined ? {} : { resolution: input.resolution }), ...params, offset, limit };
  if (status !== undefined) searched["status"] = status;
  if (input.resolution !== undefined) searched["resolution"] = input.resolution;
  const page = await t.list("/api/v1/request/", REQUEST_LIST_PARAMS, listParams, (p) => client.requests.list(p));
  return t.done(requestPage(searched, page as unknown as TastypieList<JsonObject>, offset, false, notes));
}

function requestPage(searched: Record<string, unknown>, page: TastypieList<JsonObject>, offset: number, capped: boolean, notes: string[]): RequestSearch {
  const total = page.meta.total_count;
  const requests = page.objects.map(requestRow);
  if (requests.length === 0) {
    const reason =
      offset > 0 && total > 0
        ? `The search found ${total}; offset ${offset} is past the end.`
        : `No public request matched ${JSON.stringify(searched)}. Drop a filter or use other words; only public requests are visible.`;
    return { status: "empty", searched, reason };
  }
  if (requests.some((r) => r.status === "resolved")) notes.push("resolved_on is not filled upstream: lastMessage approximates when a request closed.");
  notes.push("Only public requests are visible.");
  const next = offset + requests.length;
  return { status: "ok", searched, total, totalIsLowerBound: capped, offset, requests, ...(next < total ? { nextOffset: next } : {}), notes };
}

/** The input of {@link getRequestOutcomes}: the facets of the requests to count. */
export type RequestOutcomesInput = RequestFilters;

/** The answer of {@link getRequestOutcomes}. */
export type RequestOutcomes =
  | {
      status: "ok";
      searched: Record<string, unknown>;
      /** Every public request matching the filters. */
      total: number;
      resolved: number;
      /** Not resolved yet (awaiting a response, asleep, …): no outcome. */
      open: number;
      /** Resolved requests per resolution. */
      outcomes: Record<RequestResolution, number>;
      /** (successful + partially_successful) / resolved, in percent with one decimal; null with none resolved. */
      successRate: number | null;
      refusalRate: number | null;
      verdict: string;
      notes: string[];
    }
  | NotResolved;

/**
 * How the matching public requests went: the total, how many are resolved, and the resolved ones
 * per resolution (one counting request each, `limit=1`), with the success rate over the resolved
 * ones only: an open request has no outcome.
 */
export async function getRequestOutcomes(client: FragDenStaatClient, input: RequestOutcomesInput, options: OperationOptions = {}): Promise<RequestOutcomes> {
  const t = new Trace(client, options);
  const resolved = await resolveFilters(t, input);
  if ("status" in resolved) return t.done(resolved);
  const { params, searched, notes } = resolved;
  const count = async (extra: RequestListParams): Promise<number> =>
    (await t.list("/api/v1/request/", REQUEST_LIST_PARAMS, { ...extra, ...params, limit: 1 }, (p) => client.requests.list(p))).meta.total_count;
  const total = await count({});
  if (total === 0) {
    return t.done({ status: "empty", searched, reason: `No public request matched ${JSON.stringify(searched)}. Drop a filter, or check the names (tags, categories and classifications match exactly).` });
  }
  const done = await count({ status: "resolved" });
  const outcomes = Object.fromEntries(RequestResolutionValues.map((r) => [r, 0])) as Record<RequestResolution, number>;
  if (done > 0) {
    for (const resolution of RequestResolutionValues) outcomes[resolution] = await count({ status: "resolved", resolution });
  }
  // The counts come from separate requests; an upstream that drops a filter answers the whole set
  // to one of them. Counts that can't be true together give no rate at all.
  const counted = RequestResolutionValues.reduce((sum, r) => sum + outcomes[r], 0);
  if (done > total || counted > done) {
    const each = RequestResolutionValues.map((r) => `${r} ${outcomes[r]}`).join(", ");
    throw new FdsParseError(`The API's counts don't fit together: ${done} resolved of ${total} in all; per resolution ${each} (${counted} together). No rate is given; the API may have ignored a filter. Try again, or count fewer filters at a time.`);
  }
  const rate = (n: number): number | null => (done === 0 ? null : Math.round((n / done) * 1000) / 10);
  const successRate = rate(outcomes.successful + outcomes.partially_successful);
  const refusalRate = rate(outcomes.refused);
  if (done > 0 && counted !== done) notes.push(`${done - counted} resolved requests carry no listed resolution.`);
  notes.push("Over public requests only; anonymous access sees no others.");
  const verdict =
    done === 0
      ? `${total} requests, none resolved yet: no outcome to count.`
      : `${done} of ${total} requests resolved: ${successRate}% successful or partially successful (${outcomes.successful} + ${outcomes.partially_successful}), ${refusalRate}% refused (${outcomes.refused}), ${outcomes.not_held} not held, ${outcomes.user_withdrew + outcomes.user_withdrew_costs} withdrawn.`;
  return t.done({ status: "ok", searched, total, resolved: done, open: total - done, outcomes, successRate, refusalRate, verdict, notes });
}

// ---------------------------------------------------------------------------------------------
// findDocuments (fds-document-digger)

/**
 * A tag's slug as the site makes it (Django's slugify): accents and umlauts lose their marks and
 * any other character that isn't ASCII goes (Videoüberwachung is videouberwachung, Straße strae),
 * lower case, punctuation dropped, spaces and dashes one dash. The document list takes only a
 * slug the site has, and answers anything else with HTTP 400.
 */
export function slugOf(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/** undefined for the document list's answer to a tag slug it doesn't have (HTTP 400 on `tag`); any other error is thrown on. */
function unknownTag(err: unknown): undefined {
  if (err instanceof FdsApiError && err.status === 400) {
    try {
      const body: unknown = JSON.parse(err.body);
      if (body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 && "tag" in body) return undefined;
    } catch {
      // not the API's field error: thrown below
    }
  }
  throw err;
}

/** The answer for a tag slug the site doesn't have. */
function noSuchTag(searched: Record<string, unknown>, tag: string | undefined): NotResolved {
  return { status: "empty", searched, reason: `No document tag has the slug ${quoteValue(tag ?? "")}. Document tags are slugs (lobbyismus, videouberwachung); a request's tags are names (findRequests, searchReference kind tags): try the word another way, or another scope.` };
}

/** The input of {@link findDocuments}: at least one scope. */
export interface FindDocumentsInput {
  /** The publishing authority: its id or name. */
  publicBody?: string | undefined;
  /** One FOI request's id. */
  request?: number | string | undefined;
  /** A campaign (name or id): its documents through its requests (no direct filter exists). */
  campaign?: string | undefined;
  collection?: number | string | undefined;
  portal?: number | string | undefined;
  directory?: number | string | undefined;
  /** A tag's slug (lobbyismus), not a number. */
  tag?: string | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  offset?: number | undefined;
  /** Rows (1–50, default 20). */
  limit?: number | undefined;
}

/** The answer of {@link findDocuments}. */
export type DocumentSearch =
  | {
      status: "ok";
      searched: Record<string, unknown>;
      total: number;
      offset: number;
      documents: DocumentRow[];
      nextOffset?: number;
      /** With a campaign: its requests in all, and how many were looked through. */
      campaignRequests?: number;
      requestsScanned?: number;
      notes: string[];
    }
  | NotResolved;

/** With a campaign, at most this many of its requests are looked through for documents. */
export const CAMPAIGN_REQUESTS_SCANNED = 10;

/**
 * Documents released through FOI, by scope: an authority (id or name), a request, a campaign
 * (through its requests: `document list` has no campaign filter), a collection, portal or
 * directory, a tag slug, a date window. Metadata and file links only, nothing is downloaded;
 * getDocument reads a document's pages.
 */
export async function findDocuments(client: FragDenStaatClient, input: FindDocumentsInput, options: OperationOptions = {}): Promise<DocumentSearch> {
  const t = new Trace(client, options);
  const publicBody = textInput("publicBody", input.publicBody);
  const campaign = textInput("campaign", input.campaign);
  let tag = textInput("tag", input.tag);
  const limit = pageSize(input.limit, 20);
  const offset = pageStart(input.offset);
  const searched: Record<string, unknown> = {};
  const notes: string[] = [];
  const params: DocumentListParams = {};
  const scopes = [publicBody, input.request, campaign, input.collection, input.portal, input.directory, tag, input.createdAfter, input.createdBefore];
  if (scopes.every((v) => v === undefined)) {
    throw new FdsValidationError("Invalid input: give at least one scope: publicBody, request, campaign, collection, portal, directory, tag or a date.");
  }
  if (campaign !== undefined && input.request !== undefined) throw new FdsValidationError("Invalid input: campaign goes through its requests; give campaign or request, not both.");
  if (tag !== undefined) {
    if (/^\d+$/.test(tag)) throw new FdsValidationError(`Invalid tag: ${quoteValue(tag)} is a number; the tag filter takes a slug (lobbyismus), and a number matches nothing.`);
    const slug = slugOf(tag);
    if (slug === "") throw new FdsValidationError(`Invalid tag: ${quoteValue(tag)} has no letter or digit a slug keeps (lobbyismus, videouberwachung).`);
    if (slug !== tag) notes.push(`The tag is matched by its slug: ${quoteValue(slug)}.`);
    tag = slug;
  }
  if (publicBody !== undefined) {
    const r = await resolvePublicBody(t, publicBody);
    if (!("ref" in r)) return t.done(unresolved({ publicBody }, r));
    params.publicbody = r.ref.id;
    searched["publicBody"] = r.ref.name === "" ? { id: r.ref.id } : r.ref;
  }
  for (const [key, field] of [["request", "foirequest"], ["collection", "collection"], ["portal", "portal"], ["directory", "directory"]] as const) {
    const value = input[key];
    if (value !== undefined) {
      params[field] = normalizeResourceId(value);
      searched[key] = Number(params[field]);
    }
  }
  if (tag !== undefined) params.tag = searched["tag"] = tag;
  if (input.createdAfter !== undefined) params.created_at_after = searched["createdAfter"] = input.createdAfter;
  if (input.createdBefore !== undefined) params.created_at_before = searched["createdBefore"] = input.createdBefore;
  notes.push("Metadata and file links only: nothing is downloaded. getDocument gives a document's pages as text.");
  if (campaign !== undefined) {
    const r = await resolveCampaign(t, campaign);
    if (!("ref" in r)) return t.done(unresolved({ ...searched, campaign }, r));
    searched["campaign"] = r.ref;
    const requests = await t.list("/api/v1/request/", REQUEST_LIST_PARAMS, { campaign: r.ref.id, limit: CAMPAIGN_REQUESTS_SCANNED }, (p) => client.requests.list(p));
    // Each scanned request's first page of documents gives its count, so the total is the same
    // on every page; the documents are the requests' in order, and a page that reaches past a
    // request's first 50 reads on in that request (at most maxPages pages of it).
    const scanned: { id: number; count: number; rows: JsonObject[] }[] = [];
    for (const request of requests.objects) {
      const first = await t.list("/api/v1/document/", DOCUMENT_LIST_PARAMS, { ...params, foirequest: request.id, limit: MAX_PAGE_SIZE }, (p) => client.documents.list(p)).catch(unknownTag);
      if (first === undefined) return t.done(noSuchTag(searched, tag));
      scanned.push({ id: request.id, count: first.meta.total_count, rows: first.objects as unknown as JsonObject[] });
    }
    const found = scanned.reduce((sum, request) => sum + request.count, 0);
    const pageRows: DocumentRow[] = [];
    let start = 0;
    let unread = false;
    for (const request of scanned) {
      const from = Math.max(offset, start) - start;
      const to = Math.min(offset + limit, start + request.count) - start;
      start += request.count;
      if (from >= to) continue;
      for (let pages = 1; request.rows.length < to && pages < t.maxPages; pages++) {
        const more = await t.list("/api/v1/document/", DOCUMENT_LIST_PARAMS, { ...params, foirequest: request.id, offset: request.rows.length, limit: MAX_PAGE_SIZE }, (p) => client.documents.list(p));
        if (more.objects.length === 0) break;
        request.rows.push(...(more.objects as unknown as JsonObject[]));
      }
      pageRows.push(...request.rows.slice(from, to).map(documentRow));
      if (request.rows.length < to) {
        unread = true;
        notes.push(`Request ${request.id} has ${request.count} documents; only its first ${request.rows.length} were read (maxPages): findDocuments with request ${request.id} pages through them.`);
        break;
      }
    }
    if (requests.meta.total_count > scanned.length) notes.push(`The campaign has ${requests.meta.total_count} public requests; the documents of ${scanned.length} were looked through (newest first by the API's order): total counts theirs. For more, page findRequests with campaign and ask for documents per request.`);
    if (pageRows.length === 0) {
      return t.done({ status: "empty", searched, reason: offset > 0 && found > 0 ? `The ${scanned.length} requests looked through hold ${found} documents; offset ${offset} is past the end.` : `None of the ${scanned.length} requests looked through (of ${requests.meta.total_count} in campaign ${r.ref.name}) has public documents. Documents usually come as attachments: getRequest shows them.` });
    }
    const next = offset + pageRows.length;
    return t.done({ status: "ok", searched, total: found, offset, documents: pageRows, ...(next < found && !unread ? { nextOffset: next } : {}), campaignRequests: requests.meta.total_count, requestsScanned: scanned.length, notes });
  }
  const page = await t.list("/api/v1/document/", DOCUMENT_LIST_PARAMS, { ...params, offset, limit }, (p) => client.documents.list(p)).catch(unknownTag);
  if (page === undefined) return t.done(noSuchTag(searched, tag));
  const total = page.meta.total_count;
  const documents = (page.objects as unknown as JsonObject[]).map(documentRow);
  if (documents.length === 0) {
    const hint = tag !== undefined ? " A tag is matched by its slug (lobbyismus): check it." : "";
    const reason = offset > 0 && total > 0 ? `The search found ${total}; offset ${offset} is past the end.` : `No public document matched ${JSON.stringify(searched)}.${hint} Most requests' answers are attachments, not documents: getRequest lists them.`;
    return t.done({ status: "empty", searched, reason });
  }
  const next = offset + documents.length;
  return t.done({ status: "ok", searched, total, offset, documents, ...(next < total ? { nextOffset: next } : {}), notes });
}

// ---------------------------------------------------------------------------------------------
// findLaws (fds-law-explorer)

/** The input of {@link findLaws}: one `law`, or a list by jurisdiction, words and meta. */
export interface FindLawsInput {
  /** One law: its id or name (Informationsfreiheitsgesetz Bund): the law in full. */
  law?: string | undefined;
  /** Bund, a Land or the EU: name, slug or id. Local statutes have none. */
  jurisdiction?: string | undefined;
  /** Words of the name: a topic (umwelt) or a town (München) for its local statute. */
  query?: string | undefined;
  /** true: only meta laws (they bundle several); false: only concrete statutes. */
  meta?: boolean | undefined;
  offset?: number | undefined;
  /** Rows (1–50, default 50). */
  limit?: number | undefined;
}

/** One law in full. */
export interface LawDetail extends LawRow {
  description: string | null;
  emailOnly: boolean;
  /** The mediator (appeals body) as a public body id: findPublicBody with name = the id. */
  mediatorId: number | null;
  /** The laws a meta law bundles. */
  combined: { id: number; name: string | null }[];
  refusalReasons: string[];
  letterStart: string | null;
  letterEnd: string | null;
  /** The statute's length in characters (0 when the catalogue has none: see siteUrl). */
  legalTextChars: number;
  /** The statute's first 2000 characters. */
  legalTextExcerpt: string | null;
}

/** The answer of {@link findLaws}. */
export type LawLookup =
  | { status: "ok"; searched: Record<string, unknown>; law: LawDetail; notes: string[] }
  | { status: "ok"; searched: Record<string, unknown>; total: number; offset: number; laws: LawRow[]; nextOffset?: number; notes: string[] }
  | NotResolved;

/**
 * The FOI laws: one law in full (`law`: id or name; a meta law with the names of the laws it
 * bundles), or the laws of a jurisdiction, by words, or meta only. Every deadline comes with its
 * unit in words. A jurisdiction's laws never include the local statutes (Satzungen): they have no
 * jurisdiction, so they are found by the town's name (`query`).
 */
export async function findLaws(client: FragDenStaatClient, input: FindLawsInput, options: OperationOptions = {}): Promise<LawLookup> {
  const t = new Trace(client, options);
  const law = textInput("law", input.law);
  const jurisdiction = textInput("jurisdiction", input.jurisdiction);
  const query = textInput("query", input.query);
  const limit = pageSize(input.limit, 50);
  const offset = pageStart(input.offset);
  if (input.meta !== undefined && typeof input.meta !== "boolean") throw new FdsValidationError("Invalid meta: Expected true or false.");
  if (law !== undefined && (jurisdiction !== undefined || query !== undefined || input.meta !== undefined)) {
    throw new FdsValidationError("Invalid input: law looks one law up; jurisdiction, query and meta list laws. Give one or the other.");
  }
  // The jurisdictions' names, for every row (18 of them: one request).
  const all = (await jurisdictionsOf(t)).objects;
  const names = new Map(all.map((ref) => [ref.id, ref.name]));
  if (law !== undefined) {
    const searched = { law };
    let id: number;
    if (isDigits(law)) id = Number(law);
    else {
      const hits = await t.autocomplete("/api/v1/law/autocomplete/", law, { limit: MAX_PAGE_SIZE }, (q, page) => client.laws.autocomplete(q, page));
      const refs = hits.objects.filter((hit) => typeof hit.value === "number").map((hit) => ({ id: hit.value as number, name: hit.label }));
      const exact = refs.filter((ref) => foldName(ref.name) === foldName(law));
      const one = refs.length === 1 ? refs[0] : exact.length === 1 ? exact[0] : undefined;
      if (one === undefined) {
        if (refs.length === 0) {
          return t.done({ status: "empty", searched, reason: `No law's name holds ${quoteValue(law)} as written. The catalogue's own wording counts ("Informationsfreiheitssatzung der Stadt München", not "der Landeshauptstadt"): try fewer words, or list by jurisdiction or query.` });
        }
        return t.done(ambiguousAnswer(searched, { field: "law", value: law, candidates: [...exact, ...refs.filter((r) => !exact.includes(r))].slice(0, 20), total: hits.meta.total_count }));
      }
      id = one.id;
    }
    let detail: JsonObject;
    try {
      detail = await t.get("/api/v1/law/", id, (key) => client.laws.get(key));
    } catch (err) {
      if (isApiNotFound(err)) return t.done({ status: "empty", searched, reason: `No law has the id ${id}. Look it up by name or list a jurisdiction's laws.` });
      throw err;
    }
    const row = lawRow(detail, names);
    const combinedIds = arr(detail["combined"]).map(idFromUri).filter((v): v is number => v !== null);
    const combinedNames = new Map<number, string>();
    if (combinedIds.length > 0 && row.jurisdictionId !== null) {
      const siblings = await t.all("/api/v1/law/", LAW_LIST_PARAMS, { jurisdiction: row.jurisdictionId }, (p) => client.laws.list(p));
      for (const sibling of siblings.objects) combinedNames.set(sibling.id, sibling.name);
    }
    // A town's statute has no jurisdiction but bundles its Land's laws, and a law can bundle one
    // of another jurisdiction: those by id, one request each, at most maxPages of them.
    const unnamed = combinedIds.filter((c) => !combinedNames.has(c));
    for (const cid of unnamed.slice(0, t.maxPages)) {
      const one = await t.list("/api/v1/law/", LAW_LIST_PARAMS, { id: cid, limit: 1 }, (p) => client.laws.list(p));
      for (const law of one.objects) combinedNames.set(law.id, law.name);
    }
    const left = combinedIds.filter((c) => !combinedNames.has(c));
    const legal = str(detail["legal_text"]) ?? "";
    // The refusal reasons come as one text, a reason per line (a list in older answers).
    const rawReasons = detail["refusal_reasons"];
    const reasons = (typeof rawReasons === "string" ? rawReasons.split(/\r?\n/) : arr(rawReasons).map((r) => (typeof r === "string" ? r : Array.isArray(r) ? r.filter((x) => typeof x === "string").join(": ") : "")))
      .map((r) => r.trim())
      .filter((r) => r !== "");
    const full: LawDetail = {
      ...row,
      description: str(detail["description"]) || null,
      emailOnly: detail["email_only"] === true,
      mediatorId: idFromUri(detail["mediator"]),
      combined: combinedIds.map((cid) => ({ id: cid, name: combinedNames.get(cid) ?? null })),
      refusalReasons: reasons,
      letterStart: str(detail["letter_start"])?.replace(/\r\n/g, "\n") || null,
      letterEnd: str(detail["letter_end"])?.replace(/\r\n/g, "\n") || null,
      legalTextChars: [...legal].length,
      legalTextExcerpt: legal === "" ? null : cut(legal.replace(/\r\n/g, "\n"), 2000),
    };
    const notes = [
      `Deadline: ${full.deadline.text}${full.requiresSignature ? "; filing needs a handwritten signature" : ""}.`,
      legal === "" ? "The catalogue holds no statute text for this law (usual): the law's page (siteUrl) links it." : `The statute has ${full.legalTextChars} characters; the excerpt is its start.`,
      ...(full.combined.length > 0 ? ["A meta law: one request can invoke the laws it bundles (combined)."] : []),
      ...(left.length > 0 ? [`${left.length} of the ${combinedIds.length} bundled laws ${unnamed.length > t.maxPages ? "were not looked up (maxPages)" : "were not found"}: their names are null; findLaws with law and the id gives each (${left.join(", ")}).`] : []),
      ...(row.jurisdictionId === null ? ["A local statute: it belongs to no jurisdiction."] : []),
    ];
    return t.done({ status: "ok", searched, law: full, notes });
  }
  const searched: Record<string, unknown> = {};
  const params: LawListParams = {};
  if (jurisdiction !== undefined) {
    const known = isDigits(jurisdiction) ? all.find((r) => r.id === Number(jurisdiction)) : undefined;
    const match = known !== undefined ? { one: known } : isDigits(jurisdiction) ? { none: true as const } : pick(all, jurisdiction, (ref) => [ref.name, ref.slug]);
    if ("several" in match) return t.done(ambiguousAnswer({ jurisdiction }, { field: "jurisdiction", value: jurisdiction, candidates: match.several, total: match.several.length }));
    if (!("one" in match)) {
      return t.done({ status: "empty", searched: { jurisdiction }, reason: `No jurisdiction is ${quoteValue(jurisdiction)}. The jurisdictions: ${all.map((r) => `${r.name} (${r.id})`).join(", ")}. For a town, give it as query: local statutes have no jurisdiction.` });
    }
    params.jurisdiction = match.one.id;
    searched["jurisdiction"] = match.one;
  }
  if (query !== undefined) params.q = searched["query"] = query;
  if (input.meta !== undefined) params.meta = searched["meta"] = input.meta;
  params.offset = offset;
  params.limit = limit;
  const page = await t.list("/api/v1/law/", LAW_LIST_PARAMS, params, (p) => client.laws.list(p));
  const laws = (page.objects as unknown as JsonObject[]).map((l) => lawRow(l, names));
  const total = page.meta.total_count;
  const notes: string[] = [];
  if (params.jurisdiction !== undefined) notes.push("Local statutes (Satzungen) have no jurisdiction and are never in a jurisdiction's list: search them by the town (query).");
  if (input.meta === true) notes.push("Meta laws bundle several (a town's Satzung bundled with its Land's UIG is one); the concrete statute is a non-meta law (meta false).");
  if (input.meta === false) notes.push("Local statutes (Satzungen) are meta laws (bundled with their Land's UIG): meta false leaves them out.");
  notes.push("Every deadline is given with its unit (deadline.text): a number alone means nothing.");
  if (laws.length === 0) {
    const reason = offset > 0 && total > 0 ? `The search found ${total}; offset ${offset} is past the end.` : `No law matched ${JSON.stringify(searched)}. Words match the catalogue's own wording; try one word (umwelt, the town's name), or drop a filter.`;
    return t.done({ status: "empty", searched, reason });
  }
  const next = offset + laws.length;
  return t.done({ status: "ok", searched, total, offset, laws, ...(next < total ? { nextOffset: next } : {}), notes });
}

// ---------------------------------------------------------------------------------------------
// Generic: one request, one document, the reference lists

/** A message of a request's correspondence. */
export interface MessageRow {
  id: number;
  timestamp: string | null;
  /** True for the authority's answers, false for the requester's messages. */
  isResponse: boolean;
  sender: string | null;
  subject: string;
  /** The published text (redactions marked), whole. */
  content: string;
  contentChars: number;
  /** True when the platform hides the text. */
  contentHidden: boolean;
  attachments: { id: number; name: string; filetype: string | null; size: number | null; isRedacted: boolean; documentId: number | null; siteUrl: string | null }[];
}

/** The answer of {@link getRequest}. */
export type RequestDetail =
  | {
      status: "ok";
      searched: { id: number };
      request: RequestRow & {
        description: string;
        summary: string | null;
        refusalReason: string | null;
        law: { id: number; name: string; deadline: Deadline } | null;
        campaignId: number | null;
        reference: string | null;
      };
      messages: MessageRow[];
      messageCount: number;
      notes: string[];
    }
  | { status: "empty"; searched: { id: number }; reason: string };

/** One FOI request with its correspondence: the messages, each with its attachments. */
export async function getRequest(client: FragDenStaatClient, input: { id: number | string }, options: OperationOptions = {}): Promise<RequestDetail> {
  const t = new Trace(client, options);
  const id = Number(normalizeResourceId(input.id));
  const searched = { id };
  let detail: JsonObject;
  try {
    detail = await t.get("/api/v1/request/", id, (key) => client.requests.get(key));
  } catch (err) {
    if (isApiNotFound(err)) return t.done({ status: "empty", searched, reason: `No public request has the id ${id}: it doesn't exist or isn't public. Find requests with findRequests.` });
    throw err;
  }
  const law = obj(detail["law"]);
  const messages = arr(detail["messages"]).map(obj).filter((m): m is JsonObject => m !== null).map((m): MessageRow => {
    const content = redactedText(m["redacted_content"], m["content"]).replace(/\r\n/g, "\n");
    return {
      id: num(m["id"]) ?? 0,
      timestamp: str(m["timestamp"]),
      isResponse: m["is_response"] === true,
      sender: str(m["sender"]),
      subject: redactedText(m["redacted_subject"], m["subject"]),
      content,
      contentChars: [...content].length,
      contentHidden: m["content_hidden"] === true,
      attachments: arr(m["attachments"]).map(obj).filter((a): a is JsonObject => a !== null).map((a) => ({
        id: num(a["id"]) ?? 0,
        name: str(a["name"]) ?? "",
        filetype: str(a["filetype"]),
        size: num(a["size"]),
        isRedacted: a["is_redacted"] === true,
        documentId: idFromUri(a["document"]) ?? num(obj(a["document"])?.["id"]),
        siteUrl: platformLink(a["site_url"]),
      })),
    };
  });
  const row = requestRow(detail);
  const request = {
    ...row,
    description: redactedText(detail["redacted_description"], detail["description"]).replace(/\r\n/g, "\n"),
    summary: str(detail["summary"]) || null,
    refusalReason: str(detail["refusal_reason"]) || null,
    law: law === null ? null : { id: num(law["id"]) ?? 0, name: str(law["name"]) ?? "", deadline: deadlineOf(law["max_response_time"], law["max_response_time_unit"]) },
    campaignId: idFromUri(detail["campaign"]),
    reference: str(detail["reference"]) || null,
  };
  const notes = [
    "Texts are as published, redactions marked; they hold personal data: quote the redacted text, never try to restore it.",
    ...(row.status === "resolved" ? ["resolved_on is not filled upstream: lastMessage approximates when the request closed."] : []),
    "Attachments link to their page (siteUrl); one that became a document has a documentId for getDocument.",
  ];
  return t.done({ status: "ok", searched, request, messages, messageCount: messages.length, notes });
}

/** The answer of {@link getDocument}. */
export type DocumentDetail =
  | { status: "ok"; searched: { id: number }; document: DocumentRow; pages: { number: number; content: string }[]; pageCount: number; notes: string[] }
  | { status: "empty"; searched: { id: number }; reason: string };

/** One document with the text of its pages (OCR or the file's text layer), page by page. */
export async function getDocument(client: FragDenStaatClient, input: { id: number | string }, options: OperationOptions = {}): Promise<DocumentDetail> {
  const t = new Trace(client, options);
  const id = Number(normalizeResourceId(input.id));
  const searched = { id };
  let detail: JsonObject;
  try {
    detail = await t.get("/api/v1/document/", id, (key) => client.documents.get(key));
  } catch (err) {
    if (isApiNotFound(err)) return t.done({ status: "empty", searched, reason: `No public document has the id ${id}. Find documents with findDocuments.` });
    throw err;
  }
  const pages = arr(detail["pages"]).map(obj).filter((p): p is JsonObject => p !== null).map((p) => ({ number: num(p["number"]) ?? 0, content: (str(p["content"]) ?? "").replace(/\r\n/g, "\n") }));
  const notes = [
    pages.length === 0 ? "The API gives no page text for this document: the file (fileUrl) is the source." : "Page text is OCR or the file's text layer: check figures against the file (fileUrl) before quoting them.",
    "Documents can hold personal data; redacted files are marked by their name (geschwaerzt).",
  ];
  return t.done({ status: "ok", searched, document: documentRow(detail), pages, pageCount: pages.length, notes });
}

/** What {@link searchReference} looks up. */
export const REFERENCE_KINDS = ["jurisdictions", "categories", "classifications", "campaigns", "tags"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** A name the filters take, with its id (tags have none: the name is the value) and its details. */
export interface ReferenceItem {
  id?: number;
  name: string;
  slug?: string;
  [detail: string]: unknown;
}

/** The answer of {@link searchReference}. */
export type ReferenceSearch =
  | { status: "ok"; searched: { kind: ReferenceKind; query?: string }; total: number; offset: number; items: ReferenceItem[]; nextOffset?: number; notes?: string[] }
  | { status: "empty"; searched: { kind: ReferenceKind; query?: string }; reason: string };

/**
 * The names and ids the filters take: jurisdictions (all 18), categories and classifications (by
 * words), campaigns (all), request tags (by words; a tag's value is its exact name).
 */
export async function searchReference(client: FragDenStaatClient, input: { kind: ReferenceKind; query?: string | undefined; offset?: number | undefined; limit?: number | undefined }, options: OperationOptions = {}): Promise<ReferenceSearch> {
  const t = new Trace(client, options);
  const kind = assertValid("kind", input.kind, (v) => (REFERENCE_KINDS.includes(v) ? undefined : `Allowed choices are ${REFERENCE_KINDS.join(", ")}.`));
  const query = textInput("query", input.query);
  const limit = pageSize(input.limit, 50);
  const offset = pageStart(input.offset);
  const searched = { kind, ...(query === undefined ? {} : { query }) };
  let items: ReferenceItem[];
  let total: number;
  const notes: string[] = [];
  if (kind === "tags") {
    if (query === undefined) throw new FdsValidationError("Invalid query: tags are looked up by a word (query).");
    const hits = await t.autocomplete("/api/v1/request/tags/autocomplete/", query, { offset, limit }, (q, page) => client.requests.tagsAutocomplete(q, page));
    items = hits.objects.map((hit) => ({ name: String(hit.value) }));
    total = hits.meta.total_count;
  } else if (kind === "categories" || kind === "classifications") {
    const path = kind === "categories" ? "/api/v1/category/" : "/api/v1/classification/";
    const resource = kind === "categories" ? client.categories : client.classifications;
    const page = await t.list(path, kind === "categories" ? CATEGORY_LIST_PARAMS : CLASSIFICATION_LIST_PARAMS, { ...(query === undefined ? {} : { q: query }), offset, limit }, (p) => resource.list(p));
    items = (page.objects as unknown as JsonObject[]).map((c) => ({ id: num(c["id"]) ?? 0, name: str(c["name"]) ?? "", slug: str(c["slug"]) ?? "", depth: num(c["depth"]), parentId: idFromUri(c["parent"]) }));
    total = page.meta.total_count;
  } else {
    const path = kind === "jurisdictions" ? "/api/v1/jurisdiction/" : "/api/v1/campaign/";
    const list = (p: never): Promise<TastypieList<JsonObject>> =>
      (kind === "jurisdictions" ? client.jurisdictions.list(p) : client.campaigns.list(p)) as unknown as Promise<TastypieList<JsonObject>>;
    const whole = await t.all(path, PAGE_ONLY_PARAMS, {}, list);
    const cut = cutNote(whole, kind).trim();
    if (cut !== "") notes.push(`${cut} Raise --max-pages (maxPages) to read them all.`);
    let rows = (whole.objects as unknown as JsonObject[]).map((o) => ({
      id: num(o["id"]) ?? 0,
      name: str(o["name"]) ?? "",
      slug: str(o["slug"]) ?? "",
      ...(kind === "campaigns" ? { active: o["active"] === true, startDate: str(o["start_date"]) } : { rank: num(o["rank"]) }),
    }));
    if (query !== undefined) {
      const want = foldName(query);
      rows = rows.filter((row) => foldName(row.name).includes(want) || foldName(row.slug).includes(want));
    }
    total = rows.length;
    items = rows.slice(offset, offset + limit);
  }
  if (items.length === 0) {
    return t.done({ status: "empty", searched, reason: offset > 0 && total > 0 ? `There are ${total}; offset ${offset} is past the end.` : `No ${kind} match ${quoteValue(query ?? "")}. Try another word or a shorter one.` });
  }
  const next = offset + items.length;
  return t.done({ status: "ok", searched, total, offset, items, ...(next < total ? { nextOffset: next } : {}), ...(notes.length > 0 ? { notes } : {}) });
}
