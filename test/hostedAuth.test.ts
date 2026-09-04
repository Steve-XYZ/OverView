import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  createSessionCookie,
  hasValidSession,
  validDashboardPassword,
  validPublishAuthorization,
} from "../src/hosted/auth.ts";

const NOW = Date.parse("2026-09-03T18:00:00Z");
const SECRET = "session-secret-that-is-long-and-random-enough";

describe("hosted authentication", () => {
  it("creates a secure HttpOnly cookie and verifies it until expiry", async () => {
    const cookie = await createSessionCookie(SECRET, NOW);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    const request = new Request("https://overview.example/", { headers: { cookie } });
    assert.equal(await hasValidSession(request, SECRET, NOW + 1_000), true);
    assert.equal(await hasValidSession(request, SECRET, NOW + 31 * 24 * 60 * 60 * 1_000), false);
    assert.equal(await hasValidSession(request, `${SECRET}x`, NOW + 1_000), false);
  });

  it("keeps dashboard and publisher credentials separate", async () => {
    const publishToken = "publish-token-that-is-at-least-thirty-two-characters";
    const publishRequest = new Request("https://overview.example/api/publish", {
      headers: { authorization: `Bearer ${publishToken}` },
    });
    assert.equal(await validPublishAuthorization(publishRequest, publishToken), true);
    assert.equal(await validPublishAuthorization(publishRequest, "different-token-that-is-also-long-enough"), false);
    assert.equal(await validDashboardPassword("phone-password", "phone-password"), true);
    assert.equal(await validDashboardPassword(publishToken, "phone-password"), false);
  });
});
