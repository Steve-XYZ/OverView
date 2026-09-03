import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../src/config/config.ts";
import { resolveWebRoot, startServer, type RunningServer } from "../src/server/server.ts";
import type { ActivitySummary } from "../src/metrics/summary.ts";
import { IDENTITY, commit, seedDatabase, writeAll } from "./helpers/seed.ts";

const seeded = seedDatabase();
writeAll(seeded, {
  commits: [
    commit({ sha: "srv1", authoredAt: new Date(Date.now() - 86_400_000).toISOString(), syncRunId: seeded.syncRunId }),
  ],
});

const config = { ...defaultConfig(), identity: IDENTITY };
let server: RunningServer;

after(async () => {
  await server?.close();
  seeded.db.close();
});

describe("the local server", () => {
  it("serves a summary for the requested window", async () => {
    server = await startServer(seeded.db, config, { port: 0 });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/summary?days=7`);
    assert.equal(response.status, 200);

    const summary = (await response.json()) as ActivitySummary;
    assert.equal(summary.window.days, 7);
    assert.equal(summary.daily.length, 7);
    assert.equal(summary.totals.commitsLanded, 1);
  });

  it("falls back to the default window for junk input", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/summary?days=nonsense`);
    const summary = (await response.json()) as ActivitySummary;
    assert.equal(summary.window.days, 30);
  });

  it("answers a health check", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { ok: boolean }).ok, true);
  });

  it("refuses anything but a read", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/summary`, { method: "POST" });
    assert.equal(response.status, 405);
  });

  it("serves the page and every module it imports", async () => {
    const built = resolveWebRoot() !== null;
    const index = await fetch(`http://127.0.0.1:${server.port}/`);

    if (!built) {
      assert.equal(index.status, 503, "unbuilt, so the server should say so");
      return;
    }

    assert.equal(index.status, 200);
    const html = await index.text();

    // Every module the browser is asked to load must resolve over HTTP, including
    // the ones the entry point imports from sibling directories.
    const entry = /src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(entry, "the page must reference an entry module");

    const entryResponse = await fetch(new URL(entry, `http://127.0.0.1:${server.port}/`));
    assert.equal(entryResponse.status, 200, `${entry} must be served`);
    const source = await entryResponse.text();

    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1];
      assert.ok(specifier);
      const url = new URL(specifier, new URL(entry, `http://127.0.0.1:${server.port}/`));
      const response = await fetch(url);
      assert.equal(response.status, 200, `${specifier} imported by ${entry} must be served`);
    }
  });

  it("refuses to walk out of the asset directory", async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/../../../../etc/passwd`,
      { redirect: "manual" },
    );
    assert.equal(response.status === 403 || response.status === 404 || response.status === 503, true);
  });
});
