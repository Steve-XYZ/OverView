import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig, loadConfig, saveConfig } from "../src/config/config.ts";

async function withConfig(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overview-config-"));
  const path = join(dir, "overview.config.json");
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

describe("loadConfig", () => {
  it("lower-cases git emails so identity matching is case-insensitive", async () => {
    const path = await withConfig({
      identity: { githubLogin: "ada", gitEmails: ["Ada@Example.COM", " ada.work@example.com "] },
    });
    const { config } = await loadConfig(path);
    assert.deepEqual(config.identity.gitEmails, ["ada@example.com", "ada.work@example.com"]);
  });

  it("resolves a relative repository path against the config file", async () => {
    const path = await withConfig({ repositories: [{ path: "./checkout" }] });
    const { config, configPath } = await loadConfig(path);
    assert.equal(config.repositories[0]?.path, join(configPath, "..", "checkout"));
  });

  it("resolves a relative database path against the config file", async () => {
    const path = await withConfig({ database: ".overview/db.sqlite" });
    const { databasePath, configPath } = await loadConfig(path);
    assert.equal(databasePath, join(configPath, "..", ".overview/db.sqlite"));
  });

  it("fills in the defaults it was not given", async () => {
    const path = await withConfig({});
    const { config } = await loadConfig(path);
    assert.equal(config.sync.sinceDays, defaultConfig().sync.sinceDays);
    assert.equal(config.server.host, "127.0.0.1");
    assert.equal(config.excludePaths.includes("**/package-lock.json"), true);
  });

  it("rejects a malformed GitHub slug rather than silently skipping it", async () => {
    const path = await withConfig({ repositories: [{ path: "/tmp/x", githubRepo: "not-a-slug" }] });
    await assert.rejects(() => loadConfig(path), ConfigError);
  });

  it("rejects a repository entry with no path", async () => {
    const path = await withConfig({ repositories: [{ githubRepo: "acme/widget" }] });
    await assert.rejects(() => loadConfig(path), ConfigError);
  });

  it("reports a missing file as an actionable message", async () => {
    await assert.rejects(
      () => loadConfig(join(tmpdir(), "overview-does-not-exist", "overview.config.json")),
      /overview init/,
    );
  });

  it("round-trips through save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overview-config-"));
    const path = join(dir, "nested", "overview.config.json");
    const original = { ...defaultConfig(), identity: { githubLogin: "ada", gitEmails: ["ada@x.com"] } };
    await saveConfig(path, original);
    const { config } = await loadConfig(path);
    assert.deepEqual(config.identity, original.identity);
  });
});
