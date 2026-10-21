import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors, stderrAfterStdout } from "../src/cli/io.js";
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

test("outputState tells a missing path, an existing one (a dangling link too) and a directory (kit K7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fds-io-"));
  try {
    const file = join(dir, "out.json");
    assert.equal(defaultIO.outputState?.(file), "missing");
    writeFileSync(file, "x");
    assert.equal(defaultIO.outputState?.(file), "exists");
    assert.equal(defaultIO.outputState?.(dir), "directory");
    symlinkSync(join(dir, "nowhere.json"), join(dir, "dangling.json"));
    assert.equal(defaultIO.outputState?.(join(dir, "dangling.json")), "exists");
    symlinkSync(dir, join(dir, "dirlink"));
    assert.equal(defaultIO.outputState?.(join(dir, "dirlink")), "directory");
    // An exclusive write never follows the dangling link either.
    assert.throws(() => defaultIO.writeFile(join(dir, "dangling.json"), Buffer.from("x"), true), { code: "EEXIST" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs node under a file-size limit.
const STARTS_A_PROCESS = { timeout: 30_000 };
const IO_MODULE = fileURLToPath(new URL("../src/cli/io.js", import.meta.url));

/** `defaultIO.writeFile(path, 100 KB, exclusive)` in a node whose files may grow to 1–2 blocks only. */
function writeUnderSizeLimit(path: string, exclusive: boolean): Promise<string> {
  const script = `import { defaultIO } from ${JSON.stringify(IO_MODULE)};
try { defaultIO.writeFile(${JSON.stringify(path)}, Buffer.alloc(100_000, 120), ${exclusive}); console.log("written"); }
catch (err) { console.log(err.code ?? err.message); }`;
  // SIGXFSZ ignored (inherited through exec), so the write fails with EFBIG instead of killing
  // node; NODE_V8_COVERAGE dropped, so the child's coverage file isn't cut short.
  const sh = `trap '' XFSZ; ulimit -f 2; unset NODE_V8_COVERAGE; exec "$0" --input-type=module -e "$1"`;
  return new Promise((resolve) => execFile("/bin/sh", ["-c", sh, process.execPath, script], (_err, stdout, stderr) => resolve(stdout + stderr)));
}

test("an -o write that fails part-way leaves the old file as it was, and no cut or temporary file (kit K7)", STARTS_A_PROCESS, async () => {
  // writeFileSync truncated the file first: `-o keep.json --force` under a full disk left cut
  // JSON, the previous result gone; without --force a cut new file blocked the next run.
  const dir = mkdtempSync(join(tmpdir(), "fds-io-"));
  try {
    const keep = join(dir, "keep.json");
    writeFileSync(keep, '{"good":"previous result"}\n');
    assert.match(await writeUnderSizeLimit(keep, false), /^EFBIG/);
    assert.equal(readFileSync(keep, "utf8"), '{"good":"previous result"}\n');
    assert.match(await writeUnderSizeLimit(join(dir, "new.json"), true), /^EFBIG/);
    assert.deepEqual(readdirSync(dir), ["keep.json"], "no cut file and no temporary file is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile with --force keeps the old file's mode and writes through a symlink (kit K7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fds-io-"));
  try {
    const path = join(dir, "out.json");
    writeFileSync(path, "original");
    chmodSync(path, 0o600);
    defaultIO.writeFile(path, Buffer.from("new"), false);
    assert.equal(readFileSync(path, "utf8"), "new");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    defaultIO.writeFile(link, Buffer.from("newer"), false);
    assert.equal(readFileSync(path, "utf8"), "newer");
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
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

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});
