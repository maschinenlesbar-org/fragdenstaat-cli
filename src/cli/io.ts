// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { FragDenStaatClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";

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

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // `wx` opens exclusively: the write fails with EEXIST if the path already
  // exists, so we never silently overwrite unless the caller opted out.
  writeFile: (path, data, exclusive) =>
    writeFileSync(path, data, exclusive ? { flag: "wx" } : undefined),
  outBinary: (data) => process.stdout.write(data),
};
