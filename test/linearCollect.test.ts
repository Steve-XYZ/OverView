import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { collectFromLinear, toLinearIssue } from "../src/ingest/linear/collect.ts";
import { LinearError, linearApiKey, linearGraphql } from "../src/ingest/linear/linearApi.ts";

function stubFetch(handler: (url: string, init: { body?: string }) => unknown) {
  return (async (url: unknown, init?: { body?: string }) => handler(String(url), init ?? {})) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe("toLinearIssue", () => {
  it("upper-cases the identifier engineers type in lower case", () => {
    const record = toLinearIssue(
      {
        id: "uuid-1",
        identifier: "bos-2422",
        title: "Fix it",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
        completedAt: "2026-09-01T10:00:00Z",
        state: { name: "Done", type: "completed" },
        team: { key: "BOS" },
        url: "https://linear.app/acme/issue/BOS-2422/x",
      },
      "2026-09-03T12:00:00.000Z",
      7,
    );
    assert.equal(record?.identifier, "BOS-2422");
    assert.equal(record?.provenance.sourceSystem, "linear");
    assert.equal(record?.provenance.sourceId, "uuid-1");
  });

  it("fills in blanks rather than dropping the issue", () => {
    const record = toLinearIssue(
      { id: "uuid-2", identifier: "BOS-3", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      "2026-09-03T12:00:00.000Z",
      7,
    );
    assert.equal(record?.title, "");
    assert.equal(record?.teamKey, null);
    assert.equal(record?.completedAt, null);
  });

  it("drops rows without the keys the dashboard joins on", () => {
    assert.equal(
      toLinearIssue({ identifier: "BOS-1" }, "2026-09-03T12:00:00.000Z", 7),
      null,
    );
    assert.equal(
      toLinearIssue({ id: "uuid-3" }, "2026-09-03T12:00:00.000Z", 7),
      null,
    );
  });
});

describe("collectFromLinear", () => {
  it("walks every page of assigned issues updated since the sync window", async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      seen.push(String(init.body ?? ""));
      const body = JSON.parse(String(init.body ?? "{}")) as { variables?: { after?: string | null } };
      if (body.variables?.after === null || body.variables?.after === undefined) {
        return jsonResponse({
          data: {
            viewer: {
              assignedIssues: {
                nodes: [
                  { id: "uuid-1", identifier: "BOS-2422", title: "First", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
                ],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          viewer: {
            assignedIssues: {
              nodes: [
                { id: "uuid-2", identifier: "BOS-2423", title: "Second", createdAt: "2026-08-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    });

    const collected = await collectFromLinear({
      apiKey: "key",
      sinceIso: "2026-06-01T00:00:00.000Z",
      syncRunId: 7,
      fetchImpl,
    });

    assert.equal(collected.issues.length, 2);
    assert.deepEqual(
      collected.issues.map((issue) => issue.identifier),
      ["BOS-2422", "BOS-2423"],
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.includes("2026-06-01T00:00:00.000Z"), true);
  });

  it("skips nodes that cannot be joined to activity", async () => {
    const fetchImpl = stubFetch(() =>
      jsonResponse({
        data: {
          viewer: {
            assignedIssues: {
              nodes: [{ title: "no keys at all" }, null],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );
    const collected = await collectFromLinear({
      apiKey: "key",
      sinceIso: "2026-06-01T00:00:00.000Z",
      syncRunId: 7,
      fetchImpl,
    });
    assert.equal(collected.issues.length, 0);
  });
});

describe("linearGraphql failures", () => {
  it("reads the key from the environment and treats a blank as missing", () => {
    assert.equal(linearApiKey({}), null);
    assert.equal(linearApiKey({ LINEAR_API_KEY: "  " }), null);
    assert.equal(linearApiKey({ LINEAR_API_KEY: " lin_123 " }), "lin_123");
  });

  it("asks for the key instead of calling the network without one", async () => {
    await assert.rejects(
      () => linearGraphql("{ viewer { id } }", {}, { apiKey: null }),
      LinearError,
    );
  });

  it("reports an HTTP failure with the status", async () => {
    const fetchImpl = stubFetch(
      () => ({ ok: false, status: 401, text: async () => "unauthorised" }) as unknown as Response,
    );
    await assert.rejects(
      () => linearGraphql("{ viewer { id } }", {}, { apiKey: "bad", fetchImpl }),
      /401/,
    );
  });

  it("reports GraphQL errors rather than returning partial data", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ data: {}, errors: [{ message: "boom" }] }));
    await assert.rejects(
      () => linearGraphql("{ viewer { id } }", {}, { apiKey: "key", fetchImpl }),
      /boom/,
    );
  });

  it("rejects a response with no data", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({}));
    await assert.rejects(
      () => linearGraphql("{ viewer { id } }", {}, { apiKey: "key", fetchImpl }),
      LinearError,
    );
  });

  it("wraps a network failure so sync can warn instead of crash", async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error("socket hung up");
    });
    await assert.rejects(
      () => linearGraphql("{ viewer { id } }", {}, { apiKey: "key", fetchImpl }),
      /socket hung up/,
    );
  });
});
