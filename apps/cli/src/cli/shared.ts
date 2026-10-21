// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import { constants } from "node:buffer";
import { Command, InvalidArgumentError, Option } from "commander";
import { OutputError, isDirectoryMessage, logOf, reasonOf, type CliDeps } from "./io.js";
import { FdsError, FdsValidationError, cutForMessage } from "@maschinenlesbar.org/fragdenstaat-client/internal/errors";
import {
  DEFAULT_BASE_URL,
  cleartextProblem,
  cleanDetail,
  decodeText,
  isBidiControl,
  replacementWarning,
  type EngineOptions,
  type RawResponse,
  type RetryEvent,
} from "@maschinenlesbar.org/fragdenstaat-client/internal/engine";
import type { QueryParams } from "@maschinenlesbar.org/fragdenstaat-client/internal/query";
import {
  amountProblem,
  baseUrlProblem,
  headerValueProblem,
  idFilterProblem,
  limitProblem,
  nonBlankProblem,
  normalizeIdFilter,
  offsetProblem,
  pointProblem,
  resourceIdProblem,
  type Problem,
} from "@maschinenlesbar.org/fragdenstaat-client/internal/validate";
import { MAX_PAGE_SIZE } from "@maschinenlesbar.org/fragdenstaat-client/internal/params";
import { idListProblem, normalizeIdList } from "@maschinenlesbar.org/fragdenstaat-client/internal/filters";

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

/**
 * Apply a library rule (a `Problem` from client/validate.ts) to an argv value: the
 * reason it reports becomes commander's usage error. The CLI keeps no rule of its
 * own, so it rejects exactly what the library rejects.
 */
export function usageCheck<T>(value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/** commander value-parser: a non-empty (after trimming) string (`nonBlankProblem`). */
export function parseNonEmpty(value: string): string {
  return usageCheck(value, nonBlankProblem);
}

/**
 * commander value-parser for a resource id in a path (`get <id>`): digits only, the
 * library's `resourceIdProblem` rule.
 */
export function parseId(value: string): string {
  return usageCheck(value, resourceIdProblem);
}

/**
 * Build a commander value-parser for a point (`georegion --latlng`, `publicbody
 * --lnglat`): the library's `pointProblem` rule in the parameter's axis order.
 */
export function parsePoint(order: "lat,lng" | "lng,lat"): (value: string) => string {
  const problem = pointProblem(order);
  return (value: string) => usageCheck(value, problem);
}

/**
 * commander value-parser for `--base-url`: the library's `baseUrlProblem` rule (an
 * http(s) URL with no query, fragment, whitespace or control characters), the same
 * check the `RequestEngine` constructor runs. Checking it here makes the error name
 * the value the user passed and exit with commander's usage exit code. The raw value
 * is returned; the engine strips trailing slashes.
 */
export function parseBaseUrl(value: string): string {
  return usageCheck(value, baseUrlProblem);
}

/**
 * commander value-parser for an amount (`--costs-min/--costs-max`, e.g. `12.50`):
 * plain decimal text only — no hex, scientific or whitespace-padded forms `Number()`
 * would accept — then the library's `amountProblem` rule (finite, non-negative).
 */
export function parseNonNegativeNumber(value: string): number {
  const n = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return usageCheck(n, amountProblem);
}

/**
 * commander value-parser for a numeric id filter (`law list --jurisdiction`, ...):
 * the library's `idFilterProblem` rule, returned in its canonical number form
 * (`normalizeIdFilter`, so `007` is sent as `7`).
 */
export function parseIdFilter(value: string): number {
  return normalizeIdFilter("id", usageCheck(value, idFilterProblem));
}

/**
 * commander value-parser for a comma-separated id list (`document list --ids`,
 * `georegion list --id`, `publicbody list --regions`): the library's `idListProblem`,
 * returned canonical (`"26, 27"` becomes `"26,27"`). Upstream, one non-numeric element
 * (`26,abc`, `26;27`) dropped the whole filter and returned the unfiltered table.
 */
export function parseIdList(value: string): string {
  return normalizeIdList(usageCheck(value, idListProblem));
}

/**
 * commander value-parser for `request list --campaign`: a campaign id, or `-` for
 * requests that belong to no campaign.
 */
export function parseCampaign(value: string): number | string {
  return value === "-" ? value : parseIdFilter(value);
}

/**
 * commander value-parser for a value sent verbatim as an HTTP header (the
 * User-Agent): the library's `headerValueProblem` rule (non-empty, no control
 * characters but tab, nothing above U+00FF).
 */
export function parseHeaderValue(value: string): string {
  return usageCheck(value, headerValueProblem);
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
    throw new FdsError(`Invalid ${argName} "${cutForMessage(value)}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/**
 * Wrap a commander value-parser for a single-valued option so that a second
 * occurrence is a usage error. commander otherwise keeps only the last value, so
 * `--status resolved --status asleep` silently dropped the first. (The option must
 * have no default: commander passes the default as `previous` on the first
 * occurrence.)
 */
export function once<T>(parse: (value: string) => T): (value: string, previous: T | undefined) => T {
  return (value, previous) => {
    if (previous !== undefined) throw new InvalidArgumentError(GIVEN_TWICE);
    return parse(value);
  };
}

/** The reason commander shows for a single-value option given twice. */
const GIVEN_TWICE = "Given more than once; this option takes a single value.";

/**
 * Make giving one of `command`'s own value options twice a usage error, with the same reason
 * as `once`: commander keeps the last value silently, so `--timeout 1000 --timeout 0` switched
 * the timeout off. For the program's global options, which `once` can't guard because some
 * have a default (commander passes it as `previous` on the first occurrence): this counts per
 * Option object, so call it once on a freshly built program. Flags without a value are left
 * alone, and so is an option declared repeatable with an array default.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(GIVEN_TWICE);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
}

/**
 * `once` for the optional-value boolean filters (`--is-foi [bool]`): a repeated
 * value is a usage error; the value itself is checked later by `asBool`.
 */
export const onceValue = once((value: string) => value);

/**
 * Wrap a commander value-parser for an option whose API parameter takes a
 * comma-separated list (`--ids`): repeats accumulate, joined with ",", so
 * `--ids 1 --ids 2` sends `ids=1,2` like `--ids 1,2` instead of keeping only the
 * last value.
 */
export function commaList(
  parse: (value: string) => string,
): (value: string, previous: string | undefined) => string {
  return (value, previous) => {
    const parsed = parse(value);
    return previous === undefined ? parsed : `${previous},${parsed}`;
  };
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
 * --force was given. Any failed write (missing dir, permissions, a directory, or an
 * existing file without --force) is an OutputError, so it exits 1 with a clean message,
 * logged as an ERROR record of `fragdenstaat.output`, rather than the generic
 * "Unexpected error" handler. The EEXIST case gets a dedicated hint pointing at --force.
 */
/** The message for an existing `-o` file without `--force`. */
function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${path}" (use --force).`;
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`
 * (an FdsValidationError, a usage error), a directory, an existing path (a dangling
 * link too) without `--force`, and a file whose directory is missing, not a directory or not
 * writable (`CliIO.outputParentProblem`): OutputErrors, as the write would raise them, exit 1.
 * A stream (`/dev/null`, a FIFO, `/dev/stdout`, `>(…)`) needs no `--force`: it is written in
 * place, and nothing in it can be lost. `-o -` is stdout. The write checks again: a file that
 * appears during the request is not overwritten either.
 */
export function checkOutputTarget(deps: CliDeps, global: GlobalOptions): void {
  if (global.force === true && global.output === undefined) {
    throw new FdsValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const file = outputFile(global);
  if (file === undefined || deps.io.outputState === undefined) return;
  const state = deps.io.outputState(file);
  if (state === "directory") throw new OutputError(isDirectoryMessage(file));
  if (state === "stream") return;
  if (state === "exists" && global.force !== true) throw new OutputError(refuseOverwrite(file));
  const problem = deps.io.outputParentProblem?.(file, global.force === true);
  if (problem !== undefined) throw new OutputError(problem);
}

function writeOutput(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  try {
    deps.io.writeFile(path, data, !global.force);
  } catch (err) {
    if (err instanceof OutputError) throw err;
    // Already a clean message (a directory): kept as it is.
    if (err instanceof FdsError) throw new OutputError(err.message, { cause: err });
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw new OutputError(refuseOverwrite(path), { cause: err });
    }
    throw new OutputError(`Could not write to "${cutForMessage(path)}": ${reasonOf(err)}`, { cause: err });
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

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (an ERROR
 * of `fragdenstaat.output`, exit 1) that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** The `-o` value that means stdout, as in other Unix tools (`-o -`). */
export const STDOUT_PATH = "-";

/**
 * The file `--output` names, or undefined for stdout: no `-o` at all, or `-o -`. A
 * script that passes a variable defaulting to `-` expects stdout; writing a regular
 * file literally named `-` into the working directory surprised everyone.
 */
export function outputFile(global: GlobalOptions): string | undefined {
  return global.output === undefined || global.output === STDOUT_PATH ? undefined : global.output;
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Honors
 * --output by writing the JSON (UTF-8) to that file instead of stdout, so the
 * flag is not silently ignored on JSON commands; otherwise (and for `-o -`) prints
 * to stdout.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  const file = outputFile(global);
  if (file !== undefined) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutput(deps, global, file, data);
    logOf(deps).info("output", `Wrote ${data.length} bytes to ${file}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Render a raw (binary/text) download. Writes to the file given by --output, or
 * to stdout otherwise (also for `-o -`). Prints a short confirmation to stderr when writing a file
 * so stdout stays clean for piping.
 *
 * The confirmation reports the server's Content-Type so the user can tell what
 * the bytes actually are (e.g. an HTML/JSON error page served with a 200). When
 * writing to stdout the same Content-Type note goes to stderr, keeping stdout
 * byte-clean for piping.
 *
 * The --output path is trusted input (the user owns their shell). A failed write
 * (missing directory, permissions, read-only FS) is wrapped in a FdsError so it
 * exits 1 with a clean `ERROR [fragdenstaat.cli] could not write ...` record rather than falling
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

/**
 * Render a raw download (a CSV page): to the `-o` file, or to stdout. The "Wrote N bytes
 * to …" note follows the write; for stdout only once the write has succeeded. Resolves
 * to false when the stdout write failed (reported by handleOutputErrors), true otherwise.
 */
export async function renderRaw(deps: CliDeps, global: GlobalOptions, response: RawResponse): Promise<boolean> {
  // The Content-Type is server text: sanitised and cut at 500 characters (cleanDetail)
  // like any other server text a message quotes.
  const contentType = cleanDetail(response.contentType);
  const typeNote = contentType ? ` (Content-Type: ${contentType})` : "";
  const file = outputFile(global);
  if (file !== undefined) {
    // File path: write the server's bytes verbatim (only the terminal is at risk).
    writeOutput(deps, global, file, response.data);
    logOf(deps).info("output", `Wrote ${response.data.length} bytes to ${file}${typeNote}`);
  } else {
    // Terminal path: the text is decoded by the charset the answer declares (UTF-8 when it
    // names none), so a Latin-1 "ü" stays one; bytes that don't fit become U+FFFD, with a WARN
    // record naming the request. Then control/escape bytes are stripped so a hostile response
    // cannot drive ANSI/OSC sequences into the user's terminal, while preserving CSV structure.
    const request = response.request ?? "GET";
    const decoded = decodeText(response.data, response.contentType, request);
    if (decoded.replaced > 0) logOf(deps).warn("api", replacementWarning(request, decoded.replaced));
    const cleaned = Buffer.from(sanitizeTerminalText(decoded.text), "utf8");
    // The note only once the bytes are written: a write that fails (stdout opened
    // read-only, EBADF) is reported by handleOutputErrors, never preceded by "Wrote".
    if ((await deps.io.outBinary(cleaned)) === false) return false;
    logOf(deps).info("output", `Wrote ${cleaned.length} bytes to stdout${typeNote}`);
  }
  return true;
}


/**
 * Count the data rows of a CSV body: records outside quoted fields (a quoted cell
 * may hold line breaks), minus the header line. A trailing record separator does
 * not start a new record. Takes the text or the raw bytes (UTF-8 or another charset
 * that keeps `"`, CR and LF as single bytes): a page too large for one string (512 MB
 * and more, with the size cap lifted) is counted on its bytes, never decoded for it.
 */
export function countCsvRows(data: string | Uint8Array): number {
  const at = typeof data === "string" ? (i: number): number => data.charCodeAt(i) : (i: number): number => data[i] ?? 0;
  let records = 0;
  let inQuotes = false;
  let pending = false; // characters seen since the last record separator
  for (let i = 0; i < data.length; i++) {
    const c = at(i);
    if (c === 0x22) {
      inQuotes = !inQuotes; // an escaped "" toggles twice
      pending = true;
    } else if (c === 0x0a && !inQuotes) {
      records += 1;
      pending = false;
    } else if (c !== 0x0d) {
      pending = true;
    }
  }
  if (pending) records += 1;
  return Math.max(0, records - 1);
}

/**
 * Render a CSV page (`--csv`) like renderRaw, then — because a CSV body carries no
 * `meta.total_count` or `next` link — tell the user on stderr when the page came
 * back full, so a one-page file is never mistaken for the whole dataset. After a failed
 * stdout write there is no note at all. Resolves to the number of data rows, or
 * undefined when the stdout write failed.
 */
export async function renderCsvPage(
  deps: CliDeps,
  global: GlobalOptions,
  response: RawResponse,
  params: QueryParams,
): Promise<number | undefined> {
  if (!(await renderRaw(deps, global, response))) return undefined;
  const limit = typeof params["limit"] === "number" ? params["limit"] : MAX_PAGE_SIZE;
  const offset = typeof params["offset"] === "number" ? params["offset"] : 0;
  const rows = countCsvRows(response.data);
  if (rows > 0 && rows >= limit) {
    logOf(deps).info(
      "api",
      `the CSV holds one page, rows ${offset + 1}-${offset + rows}; there may be more. ` +
        `The API sends at most ${MAX_PAGE_SIZE} rows per request: fetch the next page with ` +
        `--offset ${offset + rows}, or read meta.total_count from the JSON output (--limit 1).`,
    );
  }
  return rows;
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
    checkOutputTarget(deps, global);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    // One warning per run, before the first request, when the base URL is plain http: to
    // a host other than loopback. Help, version and usage errors never get here.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/** commander value-parser for `--offset`: the library's `offsetProblem` rule. */
export function parseOffset(value: string): number {
  return usageCheck(parseDecimalInt(value) ?? NaN, offsetProblem);
}

/** commander value-parser for `--limit`: the library's `limitProblem` rule (1..MAX_PAGE_SIZE). */
export function parseLimit(value: string): number {
  return usageCheck(parseDecimalInt(value) ?? NaN, limitProblem);
}

/** Add the shared offset/limit pagination options to a command. */
export function addPagination(cmd: Command): Command {
  return cmd
    .option("--offset <n>", "offset within the total dataset (>= 0)", once(parseOffset))
    .option("--limit <n>", `max number of results (1..${MAX_PAGE_SIZE})`, once(parseLimit));
}

/** Add an Option constrained to a fixed set of choices. */
export function choiceOption(
  flags: string,
  description: string,
  choices: readonly string[],
): Option {
  const option = new Option(flags, description).choices([...choices]);
  // Keep commander's choice check (and the choices in --help), and reject a repeat.
  const check = option.parseArg as (value: string, previous: unknown) => string;
  return option.argParser(once((value: string) => check(value, undefined)));
}

/** Common list/pagination options resolved into Tastypie query params. */
export function paginationParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    offset: opts["offset"],
    limit: opts["limit"],
  }) as QueryParams;
}
