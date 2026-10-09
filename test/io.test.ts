import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

// Exploratory test 2026-09-26, finding 13: -o pointing at a directory.
test("writeFile names a directory instead of suggesting --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "fds-io-"));
  try {
    for (const exclusive of [true, false]) {
      assert.throws(() => defaultIO.writeFile(dir, Buffer.from("x"), exclusive), {
        name: "FdsError",
        message: `"${dir}" is a directory; give a file path to --output.`,
      });
    }
    const file = join(dir, "out.json");
    defaultIO.writeFile(file, Buffer.from("a"), true);
    assert.throws(() => defaultIO.writeFile(file, Buffer.from("b"), true), { code: "EEXIST" });
    defaultIO.writeFile(file, Buffer.from("c"), false);
    assert.equal(readFileSync(file, "utf8"), "c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setup() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, records };
}

test("another stdout write error is an ERROR record of fragdenstaat.output, in the run's format, and exits 1", () => {
  const s = setup();
  s.stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "fragdenstaat.output", msg: "Could not write to stdout: write EBADF" },
  ]);
});

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = setup();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("ENOTCONN (stdout is a socket whose reader has gone) is treated like EPIPE", () => {
  const s = setup();
  s.stdout.emit("error", writeError("ENOTCONN"));
  s.stderr.emit("error", writeError("ENOTCONN"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr is ignored, so a failed run keeps its exit code", () => {
  const s = setup();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, []);
});

test("another stderr write error exits 1", () => {
  const s = setup();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});
