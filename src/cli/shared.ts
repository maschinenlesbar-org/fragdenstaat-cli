// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import { Command, InvalidArgumentError, Option } from "commander";
import type { CliDeps } from "./io.js";
import { FdsError } from "../client/errors.js";
import { isBidiControl, sanitizeServerText, type EngineOptions, type RawResponse } from "../client/engine.js";
import type { QueryParams } from "../client/query.js";

/**
 * Parse a plain decimal integer literal exactly.
 *
 * Returns `undefined` for anything that is not a base-10 integer in the
 * canonical form `[+-]?digits`. This deliberately rejects the many alternative
 * numeric forms `Number()` would silently accept (hex `0x10`, binary `0b101`,
 * scientific `1e2`, whitespace-padded `" 5 "`, leading `+`), and rejects values
 * that overflow the safe-integer range (e.g. `99999999999999999999`, which
 * `Number()` would round to a different value before transmitting it).
 */
function parseDecimalInt(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  const n = parseDecimalInt(value);
  if (n === undefined || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * Build a commander value-parser for an integer constrained to [min, max].
 * Thrown at parse time, so commander prints a clear message and exits.
 */
export function parseBoundedInt(min: number, max?: number): (value: string) => number {
  return (value: string) => {
    const n = parseDecimalInt(value);
    if (n === undefined) throw new InvalidArgumentError("Expected an integer.");
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (max !== undefined && n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for a resource id in a path (`get <id>`): every wrapped
 * detail endpoint takes an integer id, so anything but digits is a usage error.
 * Without this, `get .` / `get ..` were resolved as dot segments by URL parsing and
 * printed the list endpoint or the API root with exit 0.
 */
export function parseId(value: string): string {
  parseNonEmpty(value);
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a numeric id (digits only).");
  }
  return value;
}

/**
 * Build a commander value-parser for a point given as two comma-separated decimal
 * numbers, in the order the API parameter uses (`latlng` on georegion, `lnglat` on
 * publicbody). The API silently ignores a value it cannot parse and returns the
 * whole unfiltered table, so the shape and the ranges (latitude within ±90,
 * longitude within ±180) are checked here; the range check also catches a swapped
 * pair such as a longitude of 120 given as latitude.
 */
export function parsePoint(order: "lat,lng" | "lng,lat"): (value: string) => string {
  return (value: string) => {
    parseNonEmpty(value);
    const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value);
    if (!match) {
      throw new InvalidArgumentError(
        `Expected "${order}" as two decimal numbers, e.g. ${order === "lat,lng" ? "51.34,12.37" : "12.37,51.34"}.`,
      );
    }
    const [a, b] = [Number(match[1]), Number(match[2])];
    const [lat, lng] = order === "lat,lng" ? [a, b] : [b, a];
    if (Math.abs(lat) > 90) {
      throw new InvalidArgumentError(`Latitude ${lat} is out of range (-90..90); the order is ${order}.`);
    }
    if (Math.abs(lng) > 180) {
      throw new InvalidArgumentError(`Longitude ${lng} is out of range (-180..180); the order is ${order}.`);
    }
    return value;
  };
}

/**
 * commander value-parser for `--base-url`: a syntactically valid absolute URL
 * whose scheme is `http:` or `https:`. The transport already rejects other
 * schemes at request time, but doing it here — at parse time — matches the
 * sibling repos' blueprint: the error is about the value the user passed
 * (`ftp://x`), not the fully-built request URL, and it exits with commander's
 * usage exit code rather than surfacing later as a network error.
 */
export function parseBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError(`Invalid URL "${value}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidArgumentError(`Unsupported protocol "${parsed.protocol}" (use http or https).`);
  }
  // Paths are appended to the base URL as a string, so a query or fragment would
  // swallow every request path ("http://h/#f" requests "/" for every command).
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  // new URL() trims surrounding whitespace silently; the raw value is what the
  // engine uses, so reject it rather than guess.
  if (value !== value.trim()) {
    throw new InvalidArgumentError("A base URL cannot have surrounding whitespace.");
  }
  return value;
}

/**
 * commander value-parser: a non-negative number, integer or decimal (e.g. a EUR
 * amount like `12.50`). Rejects non-numeric input, negatives, and the alternative
 * forms `Number()` would silently accept (hex, scientific, whitespace-padded).
 */
export function parseNonNegativeNumber(value: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative number.");
  }
  return Number(value);
}

/**
 * commander value-parser for a value sent verbatim as an HTTP header (e.g.
 * User-Agent): non-empty, no control characters (CR/LF, NUL, DEL; tab is fine) and
 * nothing above U+00FF. That is exactly what Node's http layer accepts; anything
 * else it rejects at send time with an opaque "Invalid character in header
 * content" that would surface as "Unexpected error:". Checked by char code so the
 * source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  parseNonEmpty(value);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
    if (c > 0xff) {
      throw new InvalidArgumentError("Value contains characters outside Latin-1 (above U+00FF).");
    }
  }
  return value;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a FdsError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new FdsError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** commander value-parser/accumulator for repeatable string options. */
export function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/**
 * Write bytes to the --output path, refusing to overwrite an existing file unless
 * --force was given. A failed write (missing dir, permissions, or an existing file
 * without --force) is wrapped in a FdsError so it exits 1 with a clean message
 * rather than the generic "Unexpected error" handler. The EEXIST case gets a
 * dedicated hint pointing at --force.
 */
function writeOutput(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  try {
    deps.io.writeFile(path, data, !global.force);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw new FdsError(`refusing to overwrite existing file ${path} (use --force)`, {
        cause: err,
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new FdsError(`could not write ${path}: ${reason}`, { cause: err });
  }
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/** Drop keys whose value is undefined so we only send what the user set. */
export function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. Bidi formatting characters (isBidiControl) are
 * escaped too, so server text cannot reorder what the terminal shows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a FdsError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new FdsError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Honors
 * --output by writing the JSON (UTF-8) to that file instead of stdout, so the
 * flag is not silently ignored on JSON commands; otherwise prints to stdout.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutput(deps, global, global.output, data);
    deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Render a raw (binary/text) download. Writes to the file given by --output, or
 * to stdout otherwise. Prints a short confirmation to stderr when writing a file
 * so stdout stays clean for piping.
 *
 * The confirmation reports the server's Content-Type so the user can tell what
 * the bytes actually are (e.g. an HTML/JSON error page served with a 200). When
 * writing to stdout the same Content-Type note goes to stderr, keeping stdout
 * byte-clean for piping.
 *
 * The --output path is trusted input (the user owns their shell). A failed write
 * (missing directory, permissions, read-only FS) is wrapped in a FdsError so it
 * exits 1 with a clean `Error: could not write ...` message rather than falling
 * through to the generic "Unexpected error" handler.
 */
/**
 * Strip terminal control/escape bytes from server-rendered text that is about to
 * be printed to the terminal (stdout). A hostile/MITM'd upstream can return a
 * "CSV" body laced with ANSI/OSC escape sequences (clipboard writes, title
 * spoofing, cursor tricks) that the user's terminal would execute on print. We
 * drop the C0 range (except the field/record separators CSV legitimately uses —
 * tab 0x09, LF 0x0a, CR 0x0d) plus DEL and the C1 range, without touching the CSV
 * structure. The JSON path escapes them instead (`JSON.stringify` the C0 range,
 * `escapeControlChars` DEL and C1), which keeps the JSON valid. The file (`-o`) path writes the bytes verbatim — only the
 * terminal is at risk — so this is applied on the stdout branch only.
 */
function sanitizeTerminalText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // Keep tab (0x09), LF (0x0a), CR (0x0d); drop the rest of C0, DEL, and C1.
    if (n === 0x09 || n === 0x0a || n === 0x0d) {
      out += ch;
      continue;
    }
    if (n <= 0x1f || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

export function renderRaw(deps: CliDeps, global: GlobalOptions, response: RawResponse): void {
  const contentType = sanitizeServerText(response.contentType);
  const typeNote = contentType ? ` (Content-Type: ${contentType})` : "";
  if (global.output) {
    // File path: write the server's bytes verbatim (only the terminal is at risk).
    writeOutput(deps, global, global.output, response.data);
    deps.io.err(`Wrote ${response.data.length} bytes to ${global.output}${typeNote}`);
  } else {
    // Terminal path: strip control/escape bytes so a hostile response cannot drive
    // ANSI/OSC sequences into the user's terminal, while preserving CSV structure.
    const cleaned = Buffer.from(sanitizeTerminalText(response.data.toString("utf8")), "utf8");
    deps.io.outBinary(cleaned);
    deps.io.err(`Wrote ${cleaned.length} bytes to stdout${typeNote}`);
  }
}

/**
 * The server's page size: the default and the maximum `limit` (larger values are
 * silently clamped). A CSV export is one page, like the JSON output.
 */
export const SERVER_PAGE_SIZE = 50;

/**
 * Count the data rows of a CSV body: records outside quoted fields (a quoted cell
 * may hold line breaks), minus the header line. A trailing record separator does
 * not start a new record.
 */
export function countCsvRows(text: string): number {
  let records = 0;
  let inQuotes = false;
  let pending = false; // characters seen since the last record separator
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      inQuotes = !inQuotes; // an escaped "" toggles twice
      pending = true;
    } else if (c === "\n" && !inQuotes) {
      records += 1;
      pending = false;
    } else if (c !== "\r") {
      pending = true;
    }
  }
  if (pending) records += 1;
  return Math.max(0, records - 1);
}

/**
 * Render a CSV page (`--csv`) like renderRaw, then — because a CSV body carries no
 * `meta.total_count` or `next` link — tell the user on stderr when the page came
 * back full, so a one-page file is never mistaken for the whole dataset.
 */
export function renderCsvPage(
  deps: CliDeps,
  global: GlobalOptions,
  response: RawResponse,
  params: QueryParams,
): void {
  renderRaw(deps, global, response);
  const limit = typeof params["limit"] === "number" ? params["limit"] : SERVER_PAGE_SIZE;
  const offset = typeof params["offset"] === "number" ? params["offset"] : 0;
  const rows = countCsvRows(response.data.toString("utf8"));
  if (rows > 0 && rows >= limit) {
    deps.io.err(
      `Note: the CSV holds one page, rows ${offset + 1}-${offset + rows}; there may be more. ` +
        `The API sends at most ${SERVER_PAGE_SIZE} rows per request: fetch the next page with ` +
        `--offset ${offset + rows}, or read meta.total_count from the JSON output (--limit 1).`,
    );
  }
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/** Add the shared offset/limit pagination options to a command. */
export function addPagination(cmd: Command): Command {
  return cmd
    .option("--offset <n>", "offset within the total dataset (>= 0)", parseIntArg)
    .option("--limit <n>", "max number of results (1..50)", parseBoundedInt(1, 50));
}

/** Add an Option constrained to a fixed set of choices. */
export function choiceOption(
  flags: string,
  description: string,
  choices: readonly string[],
): Option {
  return new Option(flags, description).choices([...choices]);
}

/** Common list/pagination options resolved into Tastypie query params. */
export function paginationParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    offset: opts["offset"],
    limit: opts["limit"],
  }) as QueryParams;
}
