// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { FragDenStaatClient } from "../client/client.js";
import { parseIntArg, parseNonEmpty } from "./shared.js";
import { registerRequestCommands } from "./commands/requests.js";
import { registerPublicBodyCommands } from "./commands/publicbodies.js";
import { registerLawCommands } from "./commands/laws.js";
import { registerReferenceCommands } from "./commands/reference.js";
import { registerMessageCommands } from "./commands/messages.js";
import { registerDocumentCommands } from "./commands/documents.js";

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

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("fragdenstaat")
    .description(
      "CLI for the public, read-only endpoints of the FragDenStaat.de API " +
        "(Germany's Freedom-of-Information portal, https://fragdenstaat.de)",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://fragdenstaat.de")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value", parseNonEmpty)
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option(
      "-o, --output <file>",
      "write output (JSON, or CSV with --csv) to this file",
      parseNonEmpty,
    )
    .showHelpAfterError();

  registerRequestCommands(program, deps);
  registerPublicBodyCommands(program, deps);
  registerLawCommands(program, deps);
  registerReferenceCommands(program, deps);
  registerMessageCommands(program, deps);
  registerDocumentCommands(program, deps);

  return program;
}
