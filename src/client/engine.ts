// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for the statuses the API
// documents as transient (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { FdsApiError, FdsParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://fragdenstaat.de";
const DEFAULT_USER_AGENT = "fragdenstaat-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://fragdenstaat.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new FdsParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  /** Perform a GET returning the raw bytes (non-JSON downloads). */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    return this.request("GET", path, { query, accept });
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): FdsApiError {
    const text = body.toString("utf8");
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
    return new FdsApiError({ status, url, method, body: text, detail });
  }
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
