import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorOk, renderDoctor, runDoctor } from "../src/collector/doctor.ts";

const GUARDED = ["LINEAR_API_KEY", "OVERVIEW_PUBLISH_TOKEN", "OVERVIEW_PUBLISH_URL"] as const;

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

describe("runDoctor", () => {
  it("diagnoses a missing repository path as failing", async () => {
    await withoutCredentials(async () => {
      const home = await mkdtemp(join(tmpdir(), "overview-doctor-"));
      const configPath = join(home, "overview.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          identity: { githubLogin: "tester", gitEmails: ["tester@example.com"] },
          repositories: [{ path: join(home, "no-such-checkout") }],
        }),
        "utf8",
      );
      const checks = await runDoctor({ configPath, homeDir: home });
      const byName = new Map(checks.map((check) => [check.name, check]));

      assert.equal(byName.get("config")?.status, "ok");
      assert.equal(byName.get("credentials file")?.status, "warn");
      assert.equal(byName.get("linear credential")?.status, "warn");
      assert.equal(byName.get("publish credential")?.status, "warn");
      assert.equal(byName.get("collector")?.status, "warn");
      const repo = byName.get("repo /tmp/home/no-such-checkout") ?? byName.get(
        `repo ${join(home, "no-such-checkout")}`,
      );
      assert.equal(repo?.status, "fail");
      assert.match(repo?.detail ?? "", /does not exist/);
      assert.equal(doctorOk(checks), false);

      const rendered = renderDoctor(checks);
      assert.match(rendered, /✗ repo .* does not exist/);
      assert.match(rendered, /will stay incomplete/);
    });
  });

  it("reports full health when nothing is wrong with the file-based checks", async () => {
    const rendered = renderDoctor([
      { name: "git", status: "ok", detail: "git version 2.0" },
      { name: "collector", status: "ok", detail: "loaded." },
    ]);
    assert.match(rendered, /✓ git/);
    assert.match(rendered, /Everything a scheduled run needs is present/);
    assert.equal(
      doctorOk([
        { name: "a", status: "ok", detail: "x" },
        { name: "b", status: "warn", detail: "y" },
      ]),
      false,
    );
  });
});
