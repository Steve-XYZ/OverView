import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { POST as login } from "../api/login.ts";
import { PUT as publish } from "../api/publish.ts";
import { GET as summary } from "../api/summary.ts";
import {
  DASHBOARD_PASSWORD_ENV,
  HOSTED_PUBLISH_TOKEN_ENV,
  SESSION_SECRET_ENV,
} from "../src/hosted/auth.ts";

const prior = new Map<string, string | undefined>();

before(() => {
  for (const name of [DASHBOARD_PASSWORD_ENV, HOSTED_PUBLISH_TOKEN_ENV, SESSION_SECRET_ENV]) {
    prior.set(name, process.env[name]);
  }
  process.env[DASHBOARD_PASSWORD_ENV] = "phone-password";
  process.env[HOSTED_PUBLISH_TOKEN_ENV] = "publish-token-that-is-at-least-thirty-two-characters";
  process.env[SESSION_SECRET_ENV] = "session-secret-that-is-at-least-thirty-two-characters";
});

after(() => {
  for (const [name, value] of prior) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("hosted routes", () => {
  it("rejects summary reads before touching the database", async () => {
    const response = await summary(new Request("https://overview.example/api/summary?days=30"));
    assert.equal(response.status, 401);
  });

  it("rejects publication without the independent bearer token", async () => {
    const response = await publish(new Request("https://overview.example/api/publish", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(response.status, 401);
  });

  it("sets the secure session cookie after the dashboard password", async () => {
    const body = new URLSearchParams({ password: "phone-password" });
    const response = await login(new Request("https://overview.example/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  });
});
