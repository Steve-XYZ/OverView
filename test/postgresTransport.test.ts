import { strict as assert } from "node:assert";
import { it } from "node:test";
import { csvRows, literal, postgresEnvironment } from "./helpers/postgres.ts";

it("selects the URL's host and database without putting credentials in argv", () => {
  assert.deepEqual(postgresEnvironment("postgresql://ada:p%40ss@127.0.0.1:5433/overview_test?sslmode=require"), {
    PGHOST: "127.0.0.1", PGPORT: "5433", PGDATABASE: "overview_test",
    PGUSER: "ada", PGPASSWORD: "p@ss", PGSSLMODE: "require",
  });
  assert.equal(postgresEnvironment("postgres://ada@localhost/overview_test")["PGPORT"], "5432");
  assert.throws(() => postgresEnvironment("https://localhost/overview_test"));
  assert.throws(() => postgresEnvironment("postgresql://localhost/"));
});

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
