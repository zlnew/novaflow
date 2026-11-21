import { test } from "node:test";
import assert from "node:assert/strict";
import { renderKv, renderTable } from "../../src/cli/format.ts";

test("renderTable: aligned columns with a header rule", () => {
  const out = renderTable(
    [
      { slug: "alpha", status: "active", id: "01HJ8Z9X01ABCDEFGHJKMNPQRS" },
      { slug: "beta", status: "archived", id: "01HJ8Z9X02ABCDEFGHJKMNPQRS" },
    ],
    [
      { key: "slug", header: "SLUG" },
      { key: "status", header: "STATUS" },
      { key: "id", header: "ID" },
    ],
  );
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "SLUG  STATUS   ID");
  assert.match(lines[1], /^alpha\s+active\s+01HJ/);
  assert.match(lines[2], /^beta\s+archived\s+01HJ/);
  // columns align across rows
  assert.equal(lines[1]!.indexOf("active"), lines[2]!.indexOf("archived"));
});

test("renderTable: empty row list renders just the header", () => {
  const out = renderTable([], [{ key: "slug", header: "SLUG" }]);
  assert.equal(out, "SLUG");
});

test("renderKv: 'key: value' lines for record output", () => {
  const out = renderKv([
    ["state", "completed"],
    ["run", "01HJ8Z9X01ABCDEFGHJKMNPQRS"],
  ]);
  assert.equal(out, "state: completed\nrun: 01HJ8Z9X01ABCDEFGHJKMNPQRS");
});
