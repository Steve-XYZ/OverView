import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectorPaths } from "../src/collector/launchd.ts";
import { collectorRun, readCollectorState } from "../src/collector/run.ts";

const GUARDED = ["LINEAR_API_KEY", "OVERVIEW_PUBLISH_TOKEN", "OVERVIEW_PUBLISH_URL"] as const;

async function withHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "overview-collector-"));
}

async function writeConfig(dir: string, extra: Record<string, unknown> = {}): Promise<string> {
  const path = join(dir, "overview.config.json");
  await writeFile(
    path,
    JSON.stringify({
      identity: { githubLogin: "tester", gitEmails: ["tester@example.com"] },
      repositories: [],
      ...extra,
    }),
    "utf8",
  );
  return path;
}

/** Run with production credentials hermetically sealed off. */
async function withoutCredentials<T>(work: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of GUARDED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("collectorRun", () => {
  it("syncs an empty config and records a skipped publication", async () => {
    await withoutCredentials(async () => {
      const home = await withHome();
      const configPath = await writeConfig(home);
      const lines: string[] = [];
      const { exitCode, state } = await collectorRun({
        configPath,
        paths: collectorPaths(home),
        envPath: null,
        log: (line) => lines.push(line),
      });
      assert.equal(exitCode, 1);
      assert.equal(state.sync?.ok, true);
      assert.equal(state.publish.status, "skipped");
      assert.equal(state.error, null);

      const stored = await readCollectorState(collectorPaths(home).statePath);
      assert.equal(stored?.exitCode, 1);
      assert.equal(stored?.publish.status, "skipped");

      const log = lines.join("\n");
      assert.match(log, /sync #\d+/);
      assert.match(log, /publish skipped/);
    });
  });

  it("isolates a publish failure: sync still recorded, state still written", async () => {
    await withoutCredentials(async () => {
      const home = await withHome();
      process.env["OVERVIEW_PUBLISH_TOKEN"] = "x".repeat(32);
      const configPath = await writeConfig(home, {
        publish: { endpoint: "https://127.0.0.1:1/api/publish" },
      });
      const lines: string[] = [];
      const { exitCode, state } = await collectorRun({
        configPath,
        paths: collectorPaths(home),
        envPath: null,
        log: (line) => lines.push(line),
      });
      assert.equal(exitCode, 1);
      assert.equal(state.sync?.ok, true);
      assert.equal(state.publish.status, "failed");
      assert.match(lines.join("\n"), /publish failed/);
    });
  });

  it("records a fatal config error without throwing", async () => {
    const home = await withHome();
    const { exitCode, state } = await collectorRun({
      configPath: join(home, "does-not-exist.json"),
      paths: collectorPaths(home),
      envPath: null,
      log: () => {},
    });
    assert.equal(exitCode, 1);
    assert.equal(state.sync, null);
    assert.notEqual(state.error, null);
    const stored = await readCollectorState(collectorPaths(home).statePath);
    assert.equal(stored?.exitCode, 1);
  });

  it("never writes credential values to the log or state file", async () => {
    await withoutCredentials(async () => {
      const home = await withHome();
      process.env["OVERVIEW_PUBLISH_TOKEN"] = "ovp_testsecretvalue1234567890abcdef";
      const configPath = await writeConfig(home, {
        publish: { endpoint: "https://127.0.0.1:1/api/publish" },
      });
      const lines: string[] = [];
      await collectorRun({
        configPath,
        paths: collectorPaths(home),
        envPath: null,
        log: (line) => lines.push(line),
      });
      const stateRaw = await readFile(collectorPaths(home).statePath, "utf8");
      assert.equal(lines.join("\n").includes("ovp_testsecretvalue"), false);
      assert.equal(stateRaw.includes("ovp_testsecretvalue"), false);
    });
  });
});
