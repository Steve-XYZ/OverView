import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlist,
  COLLECTOR_INTERVAL_SECONDS,
  COLLECTOR_LABEL,
  collectorPaths,
  readPlistConfig,
} from "../src/collector/launchd.ts";

describe("buildPlist", () => {
  const plist = buildPlist({
    nodePath: "/opt/node/bin/node",
    cliPath: "/Users/test/Code/OverView/dist/cli.js",
    configPath: "/Users/test/Code/OverView/overview.config.json",
    logPath: "/Users/test/.config/overview/collector.log",
  });

  it("invokes the CLI directly with no shell", () => {
    assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
    assert.match(plist, /<string>collector<\/string>/);
    assert.match(plist, /<string>run<\/string>/);
    assert.match(plist, /<string>--config<\/string>/);
    assert.equal(plist.includes("/bin/sh"), false);
    assert.equal(plist.includes("bash"), false);
  });

  it("schedules hourly and runs at login", () => {
    assert.match(plist, new RegExp(`<integer>${COLLECTOR_INTERVAL_SECONDS}</integer>`));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("carries paths but never credentials", () => {
    assert.match(plist, /overview\.config\.json/);
    assert.match(plist, /collector\.log/);
    for (const secret of ["LINEAR_API_KEY", "OVERVIEW_PUBLISH_TOKEN", "lin_api_", "ovp_"]) {
      assert.equal(plist.includes(secret), false);
    }
  });

  it("gives the job a PATH that finds git and gh without a shell", () => {
    assert.match(plist, /\/opt\/homebrew\/bin/);
    assert.match(plist, /\/opt\/node\/bin/);
  });

  it("honours a custom interval", () => {
    const custom = buildPlist({
      nodePath: "/n",
      cliPath: "/c",
      configPath: "/cfg",
      logPath: "/l",
      intervalSeconds: 1800,
    });
    assert.match(custom, /<integer>1800<\/integer>/);
  });

  it("round-trips a config path containing XML-escaped characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overview-plist-"));
    const plistPath = join(dir, "com.overview.collector.plist");
    await writeFile(
      plistPath,
      buildPlist({
        nodePath: "/n",
        cliPath: "/c",
        configPath: "/Users/test/Code & Stuff/overview.config.json",
        logPath: "/l",
        intervalSeconds: 1800,
      }),
      "utf8",
    );
    const recorded = await readPlistConfig(plistPath);
    assert.equal(recorded.configPath, "/Users/test/Code & Stuff/overview.config.json");
    assert.equal(recorded.intervalSeconds, 1800);
  });
});

describe("collectorPaths", () => {
  it("keeps the agent, log and state under the home directory", () => {
    const paths = collectorPaths("/tmp/home");
    assert.equal(paths.plistPath, `/tmp/home/Library/LaunchAgents/${COLLECTOR_LABEL}.plist`);
    assert.equal(paths.logPath, "/tmp/home/.config/overview/collector.log");
    assert.equal(paths.statePath, "/tmp/home/.config/overview/collector-state.json");
  });
});
