import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO } from "../src/cli/io.js";

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
