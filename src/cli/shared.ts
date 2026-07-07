// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import { Command, InvalidArgumentError, Option } from "commander";
import type { CliDeps } from "./io.js";
import { FdsError } from "../client/errors.js";
import type { EngineOptions, RawResponse } from "../client/engine.js";
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
 * User-Agent). Non-empty, and free of control characters — notably CR/LF, which
 * Node's http layer rejects with an opaque ERR_INVALID_CHAR at send time. Catching
 * them here yields a clean parse-time error instead of the generic "Unexpected
 * error:" fallthrough. Tab is allowed, matching Node's own header-value rule.
 */
export function parseHeaderValue(value: string): string {
  const v = parseNonEmpty(value);
  // Reject control characters (except tab) illegal in an HTTP header value —
  // notably CR/LF — which Node otherwise rejects with an opaque error at send time.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(v)) {
    throw new InvalidArgumentError("Must not contain control characters (e.g. newlines).");
  }
  return v;
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
 * Render a JSON value, pretty by default and compact with --compact. Honors
 * --output by writing the JSON (UTF-8) to that file instead of stdout, so the
 * flag is not silently ignored on JSON commands; otherwise prints to stdout.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
 * structure. The JSON path needs no equivalent because `JSON.stringify` already
 * escapes these. The file (`-o`) path writes the bytes verbatim — only the
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
  const typeNote = response.contentType ? ` (Content-Type: ${response.contentType})` : "";
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
