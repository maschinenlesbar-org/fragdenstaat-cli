// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings, and the runtime behaviour those types promise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FragDenStaatClient } from "../src/index.js";
import { constantJson } from "./helpers.js";
import * as fx from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** Every exported option interface: a consumer may pass undefined for any of its fields. */
const OPTION_TYPES = [
  "EngineOptions",
  "FilterOptions",
  "Pagination",
  "RequestListParams",
  "RequestSearchParams",
  "PublicBodyListParams",
  "PublicBodySearchParams",
  "LawListParams",
  "TreeListParams",
  "ClassificationListParams",
  "MessageListParams",
  "DocumentListParams",
  "GeoRegionListParams",
];

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "fragdenstaat-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { FragDenStaatClient, ${OPTION_TYPES.map((t) => `type ${t}`).join(", ")} } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        ...OPTION_TYPES.map((t) => `export const all${t}: ${t} = allUndefined<${t}>();`),
        "export const client = new FragDenStaatClient({ baseUrl: process.env.FRAGDENSTAAT_BASE_URL, timeoutMs: 15_000 });",
        "export const ids = async (): Promise<number[]> =>",
        "  (await client.requests.list({ status: undefined, limit: 5 }, { allowUnknownFilters: undefined })).objects.map((r) => r.id);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = constantJson(fx.requestList);
  const client = new FragDenStaatClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.requests.list({ status: undefined, jurisdiction: undefined, limit: undefined, offset: undefined }, { allowUnknownFilters: undefined });
  assert.equal(mt.last().url, "https://fragdenstaat.de/api/v1/request/");
  assert.equal(mt.last().headers?.["User-Agent"], "fragdenstaat-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});
