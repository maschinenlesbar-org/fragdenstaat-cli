// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { FdsNetworkError, redactUrl } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /**
   * Per-request timeout in milliseconds. The engine enforces it as an overall deadline
   * whatever the transport does (see `signal`); the default transport also applies it
   * as an idle-socket timeout.
   */
  timeoutMs?: number;
  /**
   * Hard cap on the response body size in bytes. The default transport aborts as soon
   * as it is exceeded; the engine checks the body it gets back from any transport.
   */
  maxResponseBytes?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline either way,
   * and enforces `maxResponseBytes` on the body it gets back, so neither limit depends on it.
   */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * A transport: one HTTP exchange, resolving with the response whatever its status.
 * The engine accepts more than the declared shape from a JavaScript transport (a fetch
 * `Headers` object or a `Map` for `headers`, header names in any case, any ArrayBuffer
 * view or ArrayBuffer as `body`) and turns anything else it returns or throws into a
 * `FdsNetworkError`.
 */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new FdsNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new FdsNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${redactUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;
    const timeoutMs = request.timeoutMs;

    // Wall-clock deadline for the whole request. `req.setTimeout()` alone is an
    // *idle-socket* timeout that resets on every received byte, so a slow-drip
    // server that sends one byte just under the idle window (and stays under
    // maxResponseBytes) could keep the request alive indefinitely. A single fixed
    // timer bounds the total time from request start to `end`, independent of the
    // byte cadence. Cleared on end/error/cap and unref'd so it never keeps the
    // event loop alive on its own.
    let deadline: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };

    // Node validates header names and values synchronously and throws a plain
    // TypeError (ERR_INVALID_CHAR, ...); keep that inside the FdsError hierarchy.
    let req: http.ClientRequest;
    try {
      req = driver.request(
        url,
        {
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let aborted = false;

          res.on("data", (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (maxBytes !== undefined && received > maxBytes) {
              aborted = true;
              clearDeadline();
              res.destroy();
              reject(new FdsNetworkError(sizeLimitMessage(maxBytes)));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (aborted) return;
            clearDeadline();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", (err) => {
            if (aborted) return; // we already rejected with the size-cap error
            clearDeadline();
            reject(new FdsNetworkError(`Response stream error: ${err.message}`, { cause: err }));
          });
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      reject(new FdsNetworkError(`Invalid request: ${reason}`, { cause: err }));
      return;
    }

    if (timeoutMs && timeoutMs > 0) {
      const timerMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
      // Idle-socket timeout (resets on activity)...
      req.setTimeout(timerMs, () => {
        req.destroy(new FdsNetworkError(`Request timed out after ${timeoutMs}ms`));
      });
      // ...plus a hard wall-clock deadline (does not reset) so a slow drip cannot
      // outlast the caller's timeout budget.
      deadline = setTimeout(() => {
        req.destroy(new FdsNetworkError(`Request exceeded the ${timeoutMs}ms deadline`));
      }, timerMs);
      // Don't let the deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    if (request.signal !== undefined) {
      const abort = (): void => {
        req.destroy(new FdsNetworkError(`Request exceeded deadline of ${request.timeoutMs ?? 0}ms`));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      clearDeadline();
      // A timeout destroy already passes a FdsNetworkError; don't double-wrap.
      reject(err instanceof FdsNetworkError ? err : new FdsNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
