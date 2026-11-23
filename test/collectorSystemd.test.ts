import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTOR_INTERVAL_SECONDS } from "../src/collector/paths.ts";
import {
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  buildSystemdService,
  buildSystemdTimer,
  readSystemdConfig,
  systemdPaths,
} from "../src/collector/systemd.ts";

const base = {
  nodePath: "/usr/bin/node",
  cliPath: "/home/test/Code/OverView/dist/cli.js",
  configPath: "/home/test/Code/OverView/overview.config.json",
  logPath: "/home/test/.config/overview/collector.log",
};

describe("buildSystemdService", () => {
  const service = buildSystemdService(base);

  it("invokes the CLI directly with no shell", () => {
    assert.match(service, /^ExecStart=\/usr\/bin\/node /m);
    assert.match(service, /collector run --config /);
    assert.equal(service.includes("/bin/sh"), false);
    assert.equal(service.includes("bash"), false);
  });

  it("runs once per timer tick instead of restarting", () => {
    assert.match(service, /^Type=oneshot$/m);
    assert.equal(/Restart=/.test(service), false);
  });

  it("appends the job log to the shared collector log", () => {
    assert.match(service, /^StandardOutput=append:\/home\/test\/\.config\/overview\/collector\.log$/m);
    assert.match(service, /^StandardError=append:\/home\/test\/\.config\/overview\/collector\.log$/m);
  });

  it("carries paths but never credentials", () => {
    assert.match(service, /overview\.config\.json/);
    for (const secret of ["LINEAR_API_KEY", "OVERVIEW_PUBLISH_TOKEN", "lin_api_", "ovp_"]) {
      assert.equal(service.includes(secret), false);
    }
  });

  it("gives the job a PATH that finds git and gh without a shell", () => {
    assert.match(service, /^Environment=PATH=.*\/usr\/bin/m);
    assert.match(service, /^Environment=PATH=.*\/usr\/local\/bin/m);
  });

  it("quotes paths with spaces and keeps % and $ literal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overview-systemd-"));
    const paths = systemdPaths(dir);
    const configPath = join(dir, "Code & Stuff", "$100% done", "overview.config.json");
    await mkdir(paths.unitDir, { recursive: true });
    await writeFile(
      paths.servicePath,
      buildSystemdService({ ...base, cliPath: join(dir, "dist", "cli.js"), configPath }),
      "utf8",
    );
    await writeFile(paths.timerPath, buildSystemdTimer(1800), "utf8");
    const recorded = await readSystemdConfig(paths);
    assert.equal(recorded.configPath, configPath);
    assert.equal(recorded.intervalSeconds, 1800);
  });
});

describe("buildSystemdTimer", () => {
  it("defaults to hourly with a first run shortly after activation", () => {
    const timer = buildSystemdTimer();
    assert.match(timer, new RegExp(`^OnUnitActiveSec=${COLLECTOR_INTERVAL_SECONDS}s$`, "m"));
    assert.match(timer, /^OnActiveSec=60s$/m);
    assert.match(timer, new RegExp(`^Unit=${SYSTEMD_SERVICE}$`, "m"));
    assert.match(timer, /^WantedBy=timers\.target$/m);
  });

  it("honours a custom interval", () => {
    assert.match(buildSystemdTimer(1800), /^OnUnitActiveSec=1800s$/m);
  });
});

describe("systemdPaths", () => {
  it("keeps the units, log and state under the home directory", () => {
    const paths = systemdPaths("/tmp/home");
    assert.equal(paths.unitDir, "/tmp/home/.config/systemd/user");
    assert.equal(paths.servicePath, `/tmp/home/.config/systemd/user/${SYSTEMD_SERVICE}`);
    assert.equal(paths.timerPath, `/tmp/home/.config/systemd/user/${SYSTEMD_TIMER}`);
    assert.equal(paths.logPath, "/tmp/home/.config/overview/collector.log");
    assert.equal(paths.statePath, "/tmp/home/.config/overview/collector-state.json");
  });
});
