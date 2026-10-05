// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { statSync, writeFileSync } from "node:fs";
import type { FragDenStaatClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";
import { FdsError } from "../client/errors.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. When `exclusive` is true the write must fail
   * (rather than overwrite) if the path already exists, so an existing file is
   * never silently clobbered; the caller surfaces that as a clear error.
   */
  writeFile(path: string, data: Buffer, exclusive?: boolean): void;
  /** Write raw bytes to stdout (binary-safe). */
  outBinary(data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EngineOptions): FragDenStaatClient;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE. That is ordinary use, so the process exits 0 at once, quietly. Any
 * other stdout error prints one `Output error: <message>` line to stderr and exits
 * 1. On stderr an EPIPE is ignored, so a failed run keeps its exit code; any other stderr
 * error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` would otherwise turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") exit(1);
  });
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // `wx` opens exclusively: the write fails with EEXIST if the path already
  // exists, so we never silently overwrite unless the caller opted out.
  writeFile: (path, data, exclusive) => {
    try {
      writeFileSync(path, data, exclusive ? { flag: "wx" } : undefined);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      // `wx` answers EEXIST and `w` EISDIR for a directory; --force cannot help there.
      if ((code === "EEXIST" || code === "EISDIR") && isDirectory(path)) {
        throw new FdsError(`"${path}" is a directory; give a file path to --output.`, { cause });
      }
      throw cause;
    }
  },
  outBinary: (data) => process.stdout.write(data),
};
