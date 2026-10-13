import { strict as assert } from "node:assert";
import { it } from "node:test";
import { csvRows, literal } from "./helpers/postgres.ts";

it("preserves SQL strings containing quotes, backslashes and newlines", () => {
  assert.equal(literal("it's \\a\nline"), "E'it''s \\\\a\nline'");
  assert.equal(literal(null), "NULL");
  assert.equal(literal(false), "FALSE");
  assert.equal(literal(42), "42");
  assert.throws(() => literal(Number.NaN));
  assert.throws(() => literal({}));
});

it("decodes psql CSV without losing empty strings, NULLs or embedded delimiters", () => {
  const csv = `title,source_url,subject
"",,"it's, \\quoted ""text""
and a line"
`;
  assert.deepEqual(csvRows(csv), [
    { title: "", source_url: null, subject: "it's, \\quoted \"text\"\nand a line" },
  ]);
  assert.deepEqual(csvRows(""), []);
  assert.throws(() => csvRows('title\n"unterminated'));
});

it("decodes JSON and booleans while retaining PostgreSQL bigint text", () => {
  assert.deepEqual(csvRows('collector,author_emails,authored_by_viewer,authored_at_ms\n"{""timeZone"":""UTC""}","[""someone@example.com""]",t,1788436800000\n'), [
    { collector: { timeZone: "UTC" }, author_emails: ["someone@example.com"], authored_by_viewer: true, authored_at_ms: "1788436800000" },
  ]);
});
