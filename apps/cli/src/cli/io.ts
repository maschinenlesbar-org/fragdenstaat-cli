// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { FragDenStaatClient } from "@maschinenlesbar.org/fragdenstaat-client/internal/client";
import type { EngineOptions } from "@maschinenlesbar.org/fragdenstaat-client/internal/engine";
import { FdsError } from "@maschinenlesbar.org/fragdenstaat-client/internal/errors";
import { createLogger, type Logger } from "./log.js";

/**
 * Writing the output to the `-o` file failed (an existing file without `--force`, a
 * missing directory, a directory, EACCES, …). Logged as an ERROR of
 * `fragdenstaat.output`, exit 1.
 */
export class OutputError extends FdsError {}

/** What an `-o` path is before the write (`CliIO.outputState`). */
export type OutputState = "missing" | "exists" | "directory";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. When `exclusive` is true the write must fail
   * (rather than overwrite) if the path already exists, so an existing file is
   * never silently clobbered; the caller surfaces that as a clear error.
   */
  writeFile(path: string, data: Buffer, exclusive?: boolean): void;
  /**
   * What the `-o` path is now, checked before any request: `"missing"`, `"exists"` (a file,
   * a link to one, or a dangling link) or `"directory"` (one, or a link to one). A CliIO
   * without it skips the early check; the write still refuses an existing file.
   */
  outputState?(path: string): OutputState;
  /**
   * Write raw bytes to stdout (binary-safe). It may return a promise that settles once
   * the write is done: `true` when it succeeded, `false` when it failed (the failure
   * itself is reported by `handleOutputErrors`). The "Wrote N bytes to stdout" note waits
   * for it and is left out after a failed write.
   */
  outBinary(data: Buffer): void | Promise<boolean>;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EngineOptions): FragDenStaatClient;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The message for an `-o` path that is a directory (`--force` can't help there). */
export function isDirectoryMessage(path: string): string {
  return `"${path}" is a directory; give a file path to --output.`;
}

/** What `path` is now: missing, a directory (or a link to one), or anything else that exists (a dangling link too). */
export function nodeOutputState(path: string): OutputState {
  try {
    lstatSync(path);
  } catch {
    return "missing";
  }
  return isDirectory(path) ? "directory" : "exists";
}

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created
 * exclusively, renamed over it. A write cut short (a full disk, a quota, a killed
 * process) leaves the old file as it was, never half of the new one. An existing
 * file's mode is kept, as the in-place write kept it.
 */
function replaceFile(target: string, data: Buffer): void {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = existingMode(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * The file a path names, through any symlinks, so `--force` replaces the file a link
 * points at (as the in-place write did) rather than the link. A dangling link is
 * replaced itself.
 */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error is an ERROR record of `fragdenstaat.output` (`Could not write to
 * stdout: <message>`, through `log`, in the run's format) and exits 1. On stderr an EPIPE
 * (or ENOTCONN) is ignored, so a failed run keeps its exit code; any other stderr error
 * exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`, with a logger for the format argv
 * asks for (`processLogger`).
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` would otherwise turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

/** What `stderrAfterStdout` needs of stdout: its backlog, and the events that end one. */
export interface StdoutBacklog {
  readonly writableLength: number;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** How often a held record checks whether stdout's backlog is gone (ms). */
const BACKLOG_POLL_MS = 10;

/**
 * A stderr writer that waits for stdout. With both streams on one pipe (`2>&1 |`) and a
 * slow reader, stdout's data is still queued in the process while a record is written
 * to stderr at once, so the record landed inside the JSON (at 64 KiB). Here a text is
 * held while `stdout.writableLength > 0` and written, in order, once the backlog is
 * gone: on stdout's `drain`, `close` or `error`, or at the latest when a short poll sees
 * it empty (`drain` only follows a write that returned false). The poll keeps the
 * process alive until then, so a held record is never lost at exit.
 */
export function stderrAfterStdout(stdout: StdoutBacklog, write: (text: string) => void): (text: string) => void {
  const held: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    for (const text of held.splice(0)) write(text);
  };
  let listening = false;
  return (text) => {
    if (held.length === 0 && stdout.writableLength === 0) return write(text);
    held.push(text);
    if (!listening) {
      listening = true;
      for (const event of ["drain", "close", "error"] as const) stdout.on(event, flush);
    }
    poll ??= setInterval(() => {
      if (stdout.writableLength === 0) flush();
    }, BACKLOG_POLL_MS);
  };
}

const stderrLine = stderrAfterStdout(process.stdout, (text) => process.stderr.write(text + "\n"));

/** A short pause for a non-blocking descriptor that is full (EAGAIN), without a busy loop. */
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `data` to `fd`, or throw. `writeSync` may write less than asked (a file-size
 * limit, a full disk): the rest is written in a loop, and the call that cannot write throws
 * (EFBIG, ENOSPC). A descriptor the shell made non-blocking (a pipe through `/dev/fd/N`) answers
 * EAGAIN while the reader is behind: wait a moment and go on.
 */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    try {
      at += writeSync(fd, data, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

/** What `stdoutWriter` needs of stdout. */
interface Stdout {
  write(data: string | Buffer): unknown;
  emit(event: "error", err: Error): unknown;
  readonly fd?: number | undefined;
}

/**
 * A writer for stdout that never drops a byte silently. When stdout is a regular file
 * (`> out.json`), Node's stream wrote it with one `writeSync` and ignored a short count, so a
 * file-size limit or a full disk cut the output short with exit 0 and nothing on stderr. Here
 * the data (text or bytes) is written with `writeAll`, and a failure (EFBIG, ENOSPC) is emitted
 * as stdout's `error`, which `handleOutputErrors` turns into an ERROR record of
 * `fragdenstaat.output` and exit 1; the writer then returns false. A pipe, a socket or a
 * terminal goes through the stream as before (EPIPE stays quiet).
 */
export function stdoutWriter(
  stdout: Stdout = process.stdout,
  write: (fd: number, data: Buffer) => void = writeAll,
): (data: string | Buffer) => boolean {
  let toFile: boolean | undefined;
  return (data) => {
    toFile ??= stdout.fd !== undefined && isRegularFile(stdout.fd);
    if (!toFile) {
      stdout.write(data);
      return true;
    }
    try {
      write(stdout.fd as number, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      return true;
    } catch (err) {
      stdout.emit("error", err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  };
}

function isRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const stdoutData = stdoutWriter();

/** Whether stdout is a regular file, where `stdoutData` writes synchronously. */
function stdoutIsFile(): boolean {
  return process.stdout.fd !== undefined && isRegularFile(process.stdout.fd);
}

export const defaultIO: CliIO = {
  out: (text) => void stdoutData(text + "\n"),
  // A record never lands inside the data when both streams share a pipe.
  err: stderrLine,
  // Atomic: the data goes to a temporary file beside the target, renamed over it when
  // complete, so a write cut short (a full disk) never leaves half a file. Exclusive (no
  // --force): the name is claimed first with an exclusive create, which fails with EEXIST if
  // the path exists (a dangling link included: it never follows one), and is removed again
  // if the write fails, so the next run isn't refused for a file holding half a result.
  writeFile: (path, data, exclusive) => {
    if (isDirectory(path)) throw new FdsError(isDirectoryMessage(path));
    let claimed = false;
    try {
      if (exclusive === true) {
        closeSync(openSync(path, "wx"));
        claimed = true;
      }
      replaceFile(exclusive === true ? path : throughLinks(path), data);
    } catch (cause) {
      if (claimed) rmSync(path, { force: true });
      throw cause;
    }
  },
  outputState: nodeOutputState,
  // Settles when the write callback fires: after the bytes are handed to the OS, or with
  // the error (EBADF, EPIPE) that the stream then also emits to handleOutputErrors.
  // To a regular file every byte is written at once (a short write is an error, `stdoutData`);
  // otherwise this settles when the write callback fires.
  outBinary: (data) =>
    stdoutIsFile()
      ? Promise.resolve(stdoutData(data))
      : new Promise<boolean>((resolve) => process.stdout.write(data, (err) => resolve(err == null))),
};
