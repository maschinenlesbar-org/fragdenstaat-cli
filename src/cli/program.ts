// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { FragDenStaatClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg, parseNonEmpty } from "./shared.js";
import { registerRequestCommands } from "./commands/requests.js";
import { registerPublicBodyCommands } from "./commands/publicbodies.js";
import { registerLawCommands } from "./commands/laws.js";
import { registerReferenceCommands } from "./commands/reference.js";
import { registerMessageCommands } from "./commands/messages.js";
import { registerDocumentCommands } from "./commands/documents.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new FragDenStaatClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("fragdenstaat")
    .description(
      "CLI for the public, read-only endpoints of the FragDenStaat.de API " +
        "(Germany's Freedom-of-Information portal, https://fragdenstaat.de)",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://fragdenstaat.de")
    .option(
      "--timeout <ms>",
      `per-request timeout in milliseconds (0..${MAX_TIMEOUT_MS})`,
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses and connection resets (0..${MAX_RETRIES}; each waits the server's Retry-After, up to 30 s)`,
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option(
      "-o, --output <file>",
      'write output (JSON, or CSV with --csv) to this file ("-" = stdout)',
      parseNonEmpty,
    )
    .option("--force", "with -o, overwrite the output file if it already exists")
    .showHelpAfterError();

  registerRequestCommands(program, deps);
  registerPublicBodyCommands(program, deps);
  registerLawCommands(program, deps);
  registerReferenceCommands(program, deps);
  registerMessageCommands(program, deps);
  registerDocumentCommands(program, deps);

  return program;
}
