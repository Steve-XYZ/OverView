import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectorEnvPath,
  inspectCollectorEnvFile,
  loadCollectorEnv,
  parseEnvFile,
} from "../src/collector/env.ts";

async function writeEnv(contents: string, mode = 0o600): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overview-env-"));
  const path = join(dir, "env");
  await writeFile(path, contents, { mode });
  // writeFile applies the process umask, so set the exact mode explicitly.
  await chmod(path, mode);
  return path;
}

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines with comments, exports and quotes", () => {
    const parsed = parseEnvFile(
      `# a comment
export LINEAR_API_KEY=lin_api_abc
OVERVIEW_PUBLISH_TOKEN="ovp_quoted value"
OVERVIEW_PUBLISH_URL='https://example.test/api/publish'
EMPTY=
`,
    );
    assert.equal(parsed.get("LINEAR_API_KEY"), "lin_api_abc");
    assert.equal(parsed.get("OVERVIEW_PUBLISH_TOKEN"), "ovp_quoted value");
    assert.equal(parsed.get("OVERVIEW_PUBLISH_URL"), "https://example.test/api/publish");
    assert.equal(parsed.get("EMPTY"), "");
  });

  it("ignores malformed lines rather than failing the run", () => {
    const parsed = parseEnvFile("not a pair\n=novalue\nLINEAR_API_KEY=ok\n");
    assert.equal(parsed.get("LINEAR_API_KEY"), "ok");
    assert.equal(parsed.has(""), false);
  });
});

describe("collectorEnvPath", () => {
  it("lives outside shell startup files", () => {
    assert.equal(collectorEnvPath("/tmp/home"), "/tmp/home/.config/overview/env");
  });
});

describe("loadCollectorEnv", () => {
  it("imports only allowlisted keys and never overrides the environment", async () => {
    const path = await writeEnv(
      "LINEAR_API_KEY=from_file\nOVERVIEW_PUBLISH_TOKEN=from_file\nSOME_OTHER_KEY=nope\n",
    );
    const env: NodeJS.ProcessEnv = { OVERVIEW_PUBLISH_TOKEN: "from_shell" };
    const result = await loadCollectorEnv(env, path);
    assert.equal(result.loaded, true);
    assert.deepEqual(result.keysPresent, ["LINEAR_API_KEY", "OVERVIEW_PUBLISH_TOKEN"]);
    assert.deepEqual(result.keysApplied, ["LINEAR_API_KEY"]);
    assert.equal(env["LINEAR_API_KEY"], "from_file");
    assert.equal(env["OVERVIEW_PUBLISH_TOKEN"], "from_shell");
    assert.equal(env["SOME_OTHER_KEY"], undefined);
  });

  it("treats a missing file as no credentials, not an error", async () => {
    const result = await loadCollectorEnv({}, join(tmpdir(), "overview-no-such-dir", "env"));
    assert.equal(result.loaded, false);
    assert.equal(result.error, null);
  });

  it("refuses a file readable beyond its owner", async () => {
    const path = await writeEnv("LINEAR_API_KEY=secret\n", 0o644);
    const env: NodeJS.ProcessEnv = {};
    const result = await loadCollectorEnv(env, path);
    assert.equal(result.loaded, false);
    assert.match(result.error ?? "", /chmod 600/);
    assert.equal(env["LINEAR_API_KEY"], undefined);
  });
});

describe("inspectCollectorEnvFile", () => {
  it("reports key names without values", async () => {
    const path = await writeEnv("LINEAR_API_KEY=lin_api_secretvalue\n");
    const inspected = await inspectCollectorEnvFile(path);
    assert.equal(inspected.exists, true);
    assert.equal(inspected.permissionsOk, true);
    assert.equal(inspected.mode, "600");
    assert.deepEqual(inspected.keysPresent, ["LINEAR_API_KEY"]);
  });

  it("flags insecure permissions for repair", async () => {
    const path = await writeEnv("LINEAR_API_KEY=x\n", 0o600);
    await chmod(path, 0o640);
    const inspected = await inspectCollectorEnvFile(path);
    assert.equal(inspected.permissionsOk, false);
    assert.match(inspected.error ?? "", /chmod 600/);
    assert.deepEqual(inspected.keysPresent, []);
  });

  it("reports filesystem errors other than ENOENT instead of reading them as missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overview-env-"));
    const blocked = join(dir, "noaccess");
    await mkdir(blocked);
    await chmod(blocked, 0o600);
    try {
      const inspected = await inspectCollectorEnvFile(join(blocked, "env"));
      assert.equal(inspected.exists, true);
      assert.equal(inspected.permissionsOk, false);
      assert.notEqual(inspected.error, null);
    } finally {
      await chmod(blocked, 0o700);
    }
  });
});
