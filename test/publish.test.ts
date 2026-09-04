import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/config/config.ts";
import {
  buildPublication,
  isPublicationEnvelope,
  publishSnapshots,
  redactForPublishing,
} from "../src/publish/publish.ts";
import { buildSummary } from "../src/metrics/summary.ts";
import { createWindow } from "../src/metrics/window.ts";
import { commit, IDENTITY, linearIssue, pullRequest, seedDatabase, writeAll } from "./helpers/seed.ts";

const NOW = Date.parse("2026-09-03T18:00:00Z");

describe("the publish boundary", () => {
  it("redacts work details before serialization while retaining metrics and identifiers", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({ sha: "private-sha", authoredAt: "2026-09-02T10:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      pullRequests: [
        pullRequest({
          id: "private-pr",
          number: 42,
          title: "BOS-123 secret launch",
          createdAt: "2026-09-01T10:00:00Z",
          mergedAt: "2026-09-02T10:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
      linearIssues: [
        linearIssue({
          id: "private-issue",
          identifier: "BOS-123",
          title: "Secret customer issue",
          completedAt: "2026-09-02T11:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });
    const config = {
      ...defaultConfig(),
      identity: IDENTITY,
      repositories: [
        { path: "/src/widget", githubRepo: "acme/widget", hostedDetail: "redacted" as const },
      ],
      publish: { endpoint: "https://overview.example/api/publish", redactLinearDetails: true },
    };
    const local = buildSummary(seeded.db, createWindow(30, NOW, "UTC"), IDENTITY);
    const hosted = redactForPublishing(local, config);
    const serialized = JSON.stringify(hosted);

    assert.equal(hosted.totals.commitsAuthored, local.totals.commitsAuthored);
    assert.equal(hosted.totals.pullRequestsMerged, local.totals.pullRequestsMerged);
    assert.equal(hosted.landedPullRequests[0]?.number, 42);
    assert.equal(hosted.landedPullRequests[0]?.title, "");
    assert.equal(hosted.landedPullRequests[0]?.url, null);
    assert.equal(hosted.recentCommits[0]?.sha, "private-sha");
    assert.equal(hosted.recentCommits[0]?.subject, "");
    assert.equal(hosted.repositories[0]?.localPath, null);
    assert.deepEqual(hosted.repositories[0]?.authorEmails, []);
    assert.deepEqual(hosted.identity.gitEmails, []);
    assert.equal(hosted.linear.completedIssues[0]?.identifier, "BOS-123");
    assert.equal(hosted.linear.completedIssues[0]?.title, "");
    assert.equal(serialized.includes("/src/widget"), false);
    assert.equal(serialized.includes("Secret customer issue"), false);
    assert.equal(serialized.includes("BOS-123 secret launch"), false);
    assert.equal(local.landedPullRequests[0]?.title, "BOS-123 secret launch", "local data is unchanged");
    seeded.db.close();
  });

  it("builds exactly 7, 30 and 90 day snapshots with a stable content id", () => {
    const seeded = seedDatabase();
    const config = { ...defaultConfig(), identity: IDENTITY };
    const first = buildPublication(seeded.db, config, NOW);
    const second = buildPublication(seeded.db, config, NOW + 60_000);

    assert.deepEqual(Object.keys(first.snapshots), ["7", "30", "90"]);
    assert.equal(first.snapshots["7"].window.days, 7);
    assert.equal(first.snapshots["30"].window.days, 30);
    assert.equal(first.snapshots["90"].window.days, 90);
    assert.equal(first.publicationId, second.publicationId);
    assert.equal(isPublicationEnvelope(first), true);
    assert.equal(isPublicationEnvelope({ ...first, token: "must-not-be-accepted" }), false);
    assert.equal(
      isPublicationEnvelope({ ...first, publicationId: "0".repeat(64) }),
      false,
      "the server contract rejects a content id that does not match the snapshots",
    );
    seeded.db.close();
  });

  it("uploads over HTTPS with the token only in the authorization header", async () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({ sha: "egress-secret", authoredAt: "2026-09-02T10:00:00Z", syncRunId: seeded.syncRunId }),
      ],
    });
    const publication = buildPublication(seeded.db, {
      ...defaultConfig(),
      identity: IDENTITY,
      repositories: [
        { path: "/src/widget", githubRepo: "acme/widget", hostedDetail: "redacted" },
      ],
    }, NOW);
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedUrl = String(input);
      receivedInit = init;
      return Response.json({ publishedAt: "2026-09-03T18:01:00.000Z", alreadyCurrent: false });
    };
    const token = "a".repeat(48);
    const result = await publishSnapshots(
      "https://overview.example/api/publish",
      token,
      publication,
      fetchImpl,
    );

    assert.equal(receivedUrl, "https://overview.example/api/publish");
    assert.equal(new Headers(receivedInit?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(String(receivedInit?.body).includes(token), false);
    assert.equal(String(receivedInit?.body).includes("Commit egress-secret"), false);
    assert.equal(String(receivedInit?.body).includes("/src/widget"), false);
    assert.equal(receivedInit?.redirect, "error");
    assert.equal(result.publishedAt, "2026-09-03T18:01:00.000Z");
    await assert.rejects(
      () => publishSnapshots("http://overview.example/api/publish", token, publication, fetchImpl),
      /HTTPS/,
    );
    seeded.db.close();
  });
});
