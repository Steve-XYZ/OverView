import { spawnSync } from "node:child_process";

if (!process.env.OVERVIEW_TEST_DATABASE_URL) {
  console.error("Set OVERVIEW_TEST_DATABASE_URL to a disposable PostgreSQL database; psql must be installed.");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "test/postgres.test.ts"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
