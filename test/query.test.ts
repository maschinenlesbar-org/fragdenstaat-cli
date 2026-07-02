import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueryString } from "../src/client/query.js";

test("omits undefined and null values", () => {
  assert.equal(buildQueryString({ a: undefined, b: null, c: "x" }), "c=x");
});

test("serialises booleans as true/false", () => {
  assert.equal(buildQueryString({ meta: true, checked: false }), "meta=true&checked=false");
});

test("serialises arrays as repeated keys", () => {
  assert.equal(buildQueryString({ tags: ["a", "b"] }), "tags=a&tags=b");
});

test("drops undefined/null entries inside arrays", () => {
  assert.equal(buildQueryString({ id: [1, undefined, 2, null] }), "id=1&id=2");
});

test("serialises Date as full ISO-8601", () => {
  const d = new Date("2024-01-02T03:04:05.000Z");
  assert.equal(buildQueryString({ since: d }), "since=2024-01-02T03%3A04%3A05.000Z");
});

test("encodes spaces as %20 not +", () => {
  assert.equal(buildQueryString({ q: "frag den staat" }), "q=frag%20den%20staat");
});

test("returns empty string when nothing survives", () => {
  assert.equal(buildQueryString({ a: undefined, b: null }), "");
});

test("coerces numbers with String()", () => {
  assert.equal(buildQueryString({ limit: 50, offset: 0 }), "limit=50&offset=0");
});
