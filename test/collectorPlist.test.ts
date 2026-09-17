import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildPlist,
  COLLECTOR_INTERVAL_SECONDS,
  COLLECTOR_LABEL,
  collectorPaths,
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
});

describe("collectorPaths", () => {
  it("keeps the agent, log and state under the home directory", () => {
    const paths = collectorPaths("/tmp/home");
    assert.equal(paths.plistPath, `/tmp/home/Library/LaunchAgents/${COLLECTOR_LABEL}.plist`);
    assert.equal(paths.logPath, "/tmp/home/.config/overview/collector.log");
    assert.equal(paths.statePath, "/tmp/home/.config/overview/collector-state.json");
  });
});
