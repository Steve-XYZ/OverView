/** Execute the production store's SQL on PostgreSQL, with no test npm dependencies.
 * psql runs each batch in a single connection. ON_ERROR_STOP closes that connection
 * on failure, rolling back its open transaction. Nothing copies the store's logic.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSqlStore, type Sql } from "../../src/hosted/neonStore.ts";

const exec = promisify(execFile);
type Row = Record<string, unknown>;
const JSON_COLUMNS = new Set(["collector", "snapshot", "author_emails", "via"]);

interface Statement extends PromiseLike<Row[]> {
  readonly text: string;
}

export function postgresStore(url: string, schema: string) {
  // Only generated identifiers are accepted; the connection URL is passed via env
  // so credentials cannot appear in the command line or execFile's error message.
  if (!/^overview_test_[a-f0-9]+$/.test(schema)) throw new Error("Invalid test schema.");

  async function run(statements: readonly string[], transaction = false): Promise<Row[][]> {
    const connectionEnv = postgresEnvironment(url);
    const marker = `result_${crypto.randomUUID()}`;
    const script = [
      `SET search_path TO ${schema};`,
      transaction ? "BEGIN;" : "",
      ...statements.flatMap((text, index) => [`\\echo ${marker}_${index}`, `${text};`]),
      transaction ? "COMMIT;" : "",
    ].join("\n");
    // Using stdin rather than -c avoids command-line length limits for publications.
    const child = exec("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1"], {
      env: { ...process.env, ...connectionEnv, PGCONNECT_TIMEOUT: "5" },
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    child.child.stdin!.end(script);
    const { stdout } = await child;
    return statements.map((_, index) => {
      const start = stdout.indexOf(`${marker}_${index}\n`);
      const end = stdout.indexOf(`${marker}_${index + 1}\n`);
      if (start < 0) throw new Error("Missing PostgreSQL result marker.");
      return csvRows(stdout.slice(start + marker.length + String(index).length + 2, end < 0 ? undefined : end));
    });
  }

  const query = (strings: TemplateStringsArray, ...values: unknown[]): Statement => {
    const text = strings.reduce((result, part, index) =>
      result + part + (index < values.length ? literal(values[index]) : ""), "");
    return { text, then: (resolve, reject) => run([text]).then(([rows]) => rows ?? []).then(resolve, reject) };
  };
  // Neon query objects defer execution until awaited, or until transaction() collects
  // them. This adapter has the same lifetime; only the transport changes to psql.
  const sql = Object.assign(query, {
    transaction: (statements: Statement[]) => run(statements.map((statement) => statement.text), true),
  }) as unknown as Sql;

  return {
    store: createSqlStore(() => sql),
    create: () => run([`CREATE SCHEMA ${schema}`]),
    drop: () => run([`DROP SCHEMA ${schema} CASCADE`]),
    execute: (statement: string) => run([statement]),
  };
}

/** libpq does not expand a URI supplied in PGDATABASE; select its fields explicitly. */
export function postgresEnvironment(url: string): Record<string, string> {
  const connection = new URL(url);
  if (!["postgres:", "postgresql:"].includes(connection.protocol)
    || connection.hostname.length === 0 || connection.pathname.length <= 1) {
    throw new Error("Use a PostgreSQL URL naming a host and a disposable database.");
  }
  return {
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGSSLMODE: connection.searchParams.get("sslmode") ?? "prefer",
  };
}

export function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid SQL number.");
    return String(value);
  }
  if (typeof value !== "string") throw new Error("Unsupported SQL parameter.");
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/** psql CSV preserves embedded commas/newlines and distinguishes NULL from "". */
export function csvRows(csv: string): Row[] {
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { field += '"'; index++; }
      else { quoted = !quoted; wasQuoted = true; }
    } else if (!quoted && (char === "," || char === "\n")) {
      record.push(field === "" && !wasQuoted ? null : field);
      field = "";
      wasQuoted = false;
      if (char === "\n") { records.push(record); record = []; }
    } else field += char;
  }
  if (quoted || field.length > 0 || record.length > 0) throw new Error("Incomplete CSV result.");
  const [columns, ...rows] = records;
  if (columns === undefined) return [];
  return rows.map((values) => Object.fromEntries(columns.map((column, index) => {
    if (column === null) throw new Error("Missing column name.");
    const value = values[index] ?? null;
    return [column, value === null ? null
      : JSON_COLUMNS.has(column) && !(column === "via" && columns.includes("sha")) ? JSON.parse(value) as unknown
      : column === "authored_by_viewer" ? value === "t"
      : value];
  })));
}
