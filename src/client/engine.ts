// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for the statuses the API
// documents as transient (429, 503), and decodes responses.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { TextDecoder } from "node:util";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  FdsApiError,
  FdsError,
  FdsNetworkError,
  FdsParseError,
  FdsValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { assertNonBlankParams, assertValid, headerValueProblem, validateBaseUrl } from "./validate.js";

export const DEFAULT_BASE_URL = "https://fragdenstaat.de";
const DEFAULT_USER_AGENT = "fragdenstaat-cli";

/** The phrase `cleartextProblem` uses for a base URL's `user:password@`. */
const USERINFO_PHRASE = "the base URL's credentials";

/**
 * Why requests to `baseUrl` would cross the network unencrypted, or `undefined`.
 *
 * Returns `undefined` for an `https:` URL, for one that does not parse, and for the
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`). For any other plain `http:`
 * URL it returns one sentence (no `warning: ` prefix) naming the host (`url.host`: host
 * and port, never the userinfo) and what secret travels with the requests: `secrets`
 * are noun phrases such as `"the API key"`, and a `user:password@` in the URL adds
 * "the base URL's credentials". The secrets themselves are never in the sentence. Not
 * an error (a mirror on a trusted network is a legitimate setup), so the CLI logs it as
 * a `WARN` record of `fragdenstaat.http` on stderr (once per run, before the first
 * request).
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 * - `the API key and the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The WHATWG parser normalises IPv4 (`127.1`, `0x7f.0.0.1`) to dotted decimal.
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const named = [...secrets];
  if (url.username !== "" || url.password !== "") named.push(USERINFO_PHRASE);
  if (named.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const subject =
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;
  const verb = named.length === 1 && named[0] !== USERINFO_PHRASE ? "is" : "are";
  return `${subject} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://fragdenstaat.de. Whitespace or control
   * characters in it are an FdsValidationError at construction.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `fragdenstaat-cli`): non-blank, Latin-1,
   * no control characters but tab, or the constructor throws an FdsValidationError.
   */
  userAgent?: string;
  /** Per-request timeout in milliseconds, 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables. */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and connection
   * resets (isTransientNetworkError), 0..`MAX_RETRIES` (10). Each waits
   * `retryDelayMs * attempt`, or the response's `Retry-After` when that is longer (up to
   * `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the FdsApiError says so).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), 0..`MAX_RETRY_AFTER_MS`
   * (30 000). It is also the floor under a `Retry-After`: the header can lengthen a wait,
   * never shorten it.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * Every numeric option must be a non-negative safe integer within its range, or
   * the constructor throws a FdsError.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Upper bound for `maxRetries` (and the CLI's `--max-retries`). */
export const MAX_RETRIES = 10;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Validate a numeric engine option: absent means the default; anything but a safe
 * integer in 0..max is an FdsValidationError. Without this, a negative or NaN `timeoutMs`
 * silently disabled the timeout, a negative `maxResponseBytes` the size cap, and a
 * negative `retryDelayMs` produced a Node TimeoutNegativeWarning.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new FdsValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${cutForMessage(String(value))}.`,
    );
  }
  return value;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which passes as an object but has no
 * plain properties: the engine then saw no Retry-After, no Content-Type and no Location.
 * Such an object (anything with `get` and `forEach`, a `Map` too) is copied into a record;
 * a plain record gets its names lower-cased, as the engine reads them.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Content-Type").
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a failure caused by a reset or aborted connection, which the engine retries —
 * whichever transport raised it (the default transport's FdsNetworkError, Node's own
 * error, fetch's TypeError with an undici cause). A refused connection, a DNS failure or
 * a timeout is not transient in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return hasTransientCode(err);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages use redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined rather
    // than failing with a raw TypeError on the first property read.
    options = options ?? {};
    // Checked on the raw value, before the trailing-slash strip: new URL() ignores
    // whitespace, and a trailing space would defeat the strip. A malformed value is an
    // FdsValidationError (a configuration error, not a transport failure); the default
    // transport still re-checks each request URL's scheme as an FdsNetworkError.
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // A blank, control-character or non-Latin-1 value is an FdsValidationError here,
    // not a raw TypeError from Node at send time (or CR/LF handed to a custom transport).
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws a FdsError for a path with a "." or ".." segment. The resource methods
   * put ids into the path with `encodeURIComponent`, which leaves those two
   * unchanged, and URL parsing then resolves them: `requests.get(".")` would request
   * `/api/v1/request/` (the list) and `get("..")` the API root. Neither can name a
   * resource. (Percent-encoded forms such as "%2e%2e" are safe: encodeURIComponent
   * turns their "%" into "%25".)
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${cutForMessage(path)}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new FdsError(
        `Invalid path segment "${dotSegment}" in ${cutForMessage(normalizedPath)}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new FdsNetworkError(`Request exceeded deadline of ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform a request with Accept negotiation and transient-error retries. A query
   * with a blank value (or blank parameter name) is rejected with an
   * FdsValidationError before anything is sent: the API reads an empty parameter
   * as "no filter" and would answer with the unfiltered dataset.
   */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    if (options.query) assertNonBlankParams(options.query);
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset or a 503 may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET, whichever transport reported it. Timeouts are not retried —
        // a slow upstream should not be asked again at once, and timeoutMs bounds each
        // attempt.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.toNetworkError(method, url, cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the FdsError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new FdsNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new FdsNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }

      const retryable = status === 429 || status === 503;
      // A Retry-After beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at
      // once and names the wait the server asked for.
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      const tooLong = retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
      if (idempotent && retryable && !tooLong && attempt < this.maxRetries) {
        attempt += 1;
        // Back off linearly from retryDelayMs. A Retry-After can ask for longer, never for
        // less: `Retry-After: 0` or a date in the past turned the retries into a zero-delay
        // burst against a server that had just asked for less load.
        const backoff = this.retryDelayMs * attempt;
        await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
        continue;
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        const location = responseHeaders["location"];
        throw this.toApiError(method, url, status, body, typeof location === "string" ? location : undefined, {
          retries: attempt,
          ...(tooLong ? { retryAfterMs: retryAfter } : {}),
        });
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * A transport failure as the library's error. The default transport rejects with
   * FdsNetworkError only, which passes through; an injected one may throw anything — a
   * plain Error, fetch's TypeError, a string, null. That becomes a FdsNetworkError naming
   * the request (URL redacted), with the original as `cause`, so a caller (and the CLI)
   * can rely on every failure being a FdsError. Any other FdsError passes through.
   */
  private toNetworkError(method: string, url: string, cause: unknown): FdsError {
    if (cause instanceof FdsError && !(cause instanceof FdsNetworkError)) return cause;
    if (cause instanceof FdsNetworkError) {
      // The default transport's own errors carry no URL; scrub one that does anyway.
      const scrubbed = this.scrubCause(cause);
      if (scrubbed === cause) return cause;
      return new FdsNetworkError(this.scrub(cause.message), { cause: this.scrubCause(cause.cause) });
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new FdsNetworkError(`${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`, {
      cause: this.scrubCause(cause),
    });
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. With `shape`, the parsed value
   * must have the documented form (responseShapeProblem), or the call throws an
   * FdsParseError: a `null`, `{}`, `{"detail": "Wartung"}` or an array answered with a
   * 2xx would otherwise be printed as data with exit 0, or read as "nothing found".
   */
  async getJson<T>(path: string, query?: QueryParams, shape?: ResponseShape): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = decodeBody(res.data, res.contentType, path);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type,
      // so it reads as an upstream problem rather than a client bug.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? `: expected JSON, got Content-Type "${cleanDetail(type)}"` : "";
      throw new FdsParseError(`Failed to parse JSON response from ${cutForMessage(path)}${hint}`, { cause });
    }
    const problem = shape === undefined ? undefined : responseShapeProblem(value, shape);
    if (problem !== undefined) {
      throw new FdsParseError(`Unexpected response from ${cutForMessage(path)} (HTTP ${res.status}): ${problem}`);
    }
    return value as T;
  }

  /**
   * Perform a GET returning the raw bytes (the server-rendered CSV). An HTML page (a
   * maintenance or login page, a proxy's error page) or a JSON body answered with a 2xx
   * to a CSV request is an FdsParseError, not a download: the CLI would otherwise print
   * it, or save it over the user's `-o` file, with exit 0.
   */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    const res = await this.request("GET", path, { query, accept });
    const type = res.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const got = isHtml(res) ? "an HTML page" : !/json/i.test(accept) && /[/+]json$/.test(type) ? "JSON" : undefined;
    if (got !== undefined) {
      throw new FdsParseError(
        `Unexpected response from ${cutForMessage(path)} (HTTP ${res.status}): expected ${accept}, got ${got}` +
          (res.contentType === "" ? "" : ` (Content-Type "${cleanDetail(res.contentType)}")`),
      );
    }
    return res;
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader: string | undefined,
    retry: { retries: number; retryAfterMs?: number },
  ): FdsApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        detail?: unknown;
        error_message?: unknown;
        error?: unknown;
      };
      // FragDenStaat emits two error-body shapes:
      //   - `{"detail": "<message>"}` for 404/406/format errors, and
      //   - `{"<field>": ["<message>", ...]}` for 400 validation errors, keyed by
      //     the offending filter/field (the map sits at the top level, not under
      //     `detail`). Tastypie 500s may instead carry `error_message` / `error`.
      // Try each in turn, falling back to treating the whole body as a
      // field->messages map so 400 validation messages are surfaced.
      detail =
        formatDetail(parsed?.detail) ??
        firstString(parsed?.error_message) ??
        firstString(parsed?.error) ??
        formatDetail(parsed);
    } catch {
      // Non-JSON error body (e.g. an HTML error page); leave detail undefined.
    }
    // `detail` came from the attacker-controllable response body; JSON.parse
    // decodes a backslash-u001b escape into a real ESC byte, so without stripping
    // control characters a hostile/MITM'd endpoint could drive ANSI/OSC escape
    // sequences into the user's terminal when this error message is printed to
    // stderr. The CLI's JSON output is escaped separately (escapeControlChars in
    // cli/shared.ts): JSON.stringify alone leaves DEL and the C1 range raw.
    // ... and cap its length, so a hostile or buggy body cannot flood stderr with one huge
    // line (FdsApiError.body keeps the full text).
    if (detail !== undefined) detail = cleanDetail(detail);
    // Redirects are not followed; name the target so the user can fix --base-url.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new FdsApiError({
      status,
      url,
      method,
      body: text,
      detail,
      location,
      retries: retry.retries,
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs, maxRetryAfterMs: MAX_RETRY_AFTER_MS }),
    });
  }
}

/**
 * The documented form of a JSON answer, checked by `getJson`:
 * - `"list"`: the Tastypie envelope every list, search and autocomplete endpoint returns —
 *   an object with an `objects` array and a `meta` object holding a numeric `total_count`;
 * - `"record"`: a non-empty object, not an array (a detail endpoint's single object).
 */
export type ResponseShape = "list" | "record";

/** Why `value` does not have the documented form `shape`, or undefined when it does. */
export function responseShapeProblem(value: unknown, shape: ResponseShape): string | undefined {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const describe = (): string =>
    value === null ? "null" : Array.isArray(value) ? "an array" : isObject ? "an object" : `a ${typeof value}`;
  if (!isObject) return `expected ${shape === "list" ? "a { meta, objects } list" : "an object"}, got ${describe()}.`;
  if (shape === "record") {
    return Object.keys(value).length === 0 ? "expected a record, got an empty object." : undefined;
  }
  const page = value as { meta?: unknown; objects?: unknown };
  if (!Array.isArray(page.objects)) return "expected a { meta, objects } list with an objects array.";
  const meta = page.meta as { total_count?: unknown } | null | undefined;
  if (typeof meta !== "object" || meta === null || typeof meta.total_count !== "number" || !Number.isFinite(meta.total_count)) {
    return "expected a { meta, objects } list with a numeric meta.total_count.";
  }
  return undefined;
}

/** True for a response that is an HTML page: by its Content-Type, or by its first bytes. */
function isHtml(res: RawResponse): boolean {
  const type = res.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  const head = res.data.subarray(0, 512).toString("latin1").replace(/^\uFEFF|^\xEF\xBB\xBF/, "").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Longest server text (in characters) an error message keeps; a longer one ends in "…". */
export const MAX_DETAIL_LENGTH = 500;

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair). */
export function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return clean.length > MAX_DETAIL_LENGTH ? `${cutText(clean, MAX_DETAIL_LENGTH)}…` : clean;
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy or a backend change cannot turn a
 * valid answer into a parse error, and a Latin-1 body keeps its umlauts. An unknown
 * charset label is an FdsParseError.
 */
export function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new FdsParseError(`Unsupported response charset "${cleanDetail(charset)}" from ${cutForMessage(path)}.`);
  }
  return decoder.decode(body);
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control/bidi characters stripped (it is server text bound
 * for stderr). An unparseable value is shown sanitised as it came, with any userinfo
 * cut out by text.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  let target: string;
  try {
    target = redactUrl(new URL(location, requestUrl).href);
  } catch {
    // Unparseable (`http://bob:hunter2@exa mple/`): still cut any userinfo out by text.
    target = redactUrl(location);
  }
  const clean = cleanDetail(target);
  return clean === "" ? undefined : clean;
}

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response — the error
 * `detail`, a redirect `Location`, the echoed Content-Type — safe to print into an
 * error message on stderr:
 *
 * - C0 and C1 controls and DEL are dropped. A JSON error body can encode an escape
 *   (U+001B) that JSON.parse turns into a real control byte; printed raw, a hostile
 *   or MITM'd endpoint could drive ANSI/OSC sequences into the terminal.
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 *
 * Written as a char-code filter so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Turn an error `detail` field into a human-readable string. Handles the shapes
 * the API emits:
 *   - a plain string (DRF's `{"detail": "Not found."}`),
 *   - an array of messages, and
 *   - a field->messages object (DRF validation errors, e.g.
 *     `{"detail": {"limit": ["Enter a whole number."]}}`).
 * Returns `undefined` when there is nothing useful to surface.
 */
function formatDetail(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail.length > 0 ? detail : undefined;
  if (Array.isArray(detail)) {
    const parts = detail.filter((p): p is string => typeof p === "string" && p.length > 0);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  if (detail && typeof detail === "object") {
    const parts: string[] = [];
    for (const [field, messages] of Object.entries(detail as Record<string, unknown>)) {
      const msgs = Array.isArray(messages)
        ? messages.filter((m): m is string => typeof m === "string")
        : typeof messages === "string"
          ? [messages]
          : [];
      if (msgs.length > 0) parts.push(`${field}: ${msgs.join(", ")}`);
    }
    if (parts.length > 0) return parts.join("; ");
  }
  return undefined;
}
