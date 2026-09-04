/** The only path by which local data crosses into the hosted mirror. */

import { createHash } from "node:crypto";
import type { OverviewConfig, RepoConfig } from "../config/config.ts";
import type { ActivitySummary } from "../metrics/summary.ts";
import { buildSummary } from "../metrics/summary.ts";
import { createWindow } from "../metrics/window.ts";
import type { Db } from "../store/db.ts";

export const PUBLICATION_SCHEMA_VERSION = 1 as const;
export const PUBLISH_ENDPOINT_ENV = "OVERVIEW_PUBLISH_URL";
export const PUBLISH_TOKEN_ENV = "OVERVIEW_PUBLISH_TOKEN";
export const PUBLISHED_WINDOWS = [7, 30, 90] as const;

export interface PublicationEnvelope {
  readonly schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  readonly publicationId: string;
  readonly snapshots: Readonly<Record<"7" | "30" | "90", ActivitySummary>>;
}

export interface PublishResult {
  readonly publishedAt: string;
  readonly alreadyCurrent: boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RepositoryRule {
  readonly names: ReadonlySet<string>;
  readonly publishedName: string;
  readonly redacted: boolean;
}

export function buildPublication(
  db: Db,
  config: OverviewConfig,
  now: number = Date.now(),
): PublicationEnvelope {
  const snapshots = Object.fromEntries(
    PUBLISHED_WINDOWS.map((days) => {
      const summary = buildSummary(db, createWindow(days, now), config.identity);
      return [String(days), redactForPublishing(summary, config)];
    }),
  ) as unknown as PublicationEnvelope["snapshots"];

  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    publicationId: publicationId(snapshots),
    snapshots,
  };
}

/**
 * This function is the explicit egress boundary. It returns a new object and never
 * mutates the summary used by the local report or loopback dashboard.
 */
export function redactForPublishing(
  summary: ActivitySummary,
  config: OverviewConfig,
): ActivitySummary {
  const rules = config.repositories.map(repositoryRule);
  const repository = (name: string): { readonly name: string; readonly redacted: boolean } => {
    const lower = name.toLowerCase();
    const rule = rules.find((candidate) => candidate.names.has(lower));
    if (rule !== undefined) return { name: rule.publishedName, redacted: rule.redacted };
    // A path-backed repository must never disclose its local checkout path, even
    // if it is a stale row no longer represented in the current config.
    if (lower.startsWith("path:")) return { name: "local-repository", redacted: true };
    return { name, redacted: false };
  };

  return {
    ...summary,
    // Email matching is a local diagnostic, not required to render hosted metrics.
    identity: { ...summary.identity, gitEmails: [] },
    landedPullRequests: summary.landedPullRequests.map((pullRequest) => {
      const rule = repository(pullRequest.repository);
      return {
        ...pullRequest,
        repository: rule.name,
        ...(rule.redacted ? { title: "", url: null } : {}),
      };
    }),
    recentCommits: summary.recentCommits.map((commit) => {
      const rule = repository(commit.repository);
      return {
        ...commit,
        repository: rule.name,
        ...(rule.redacted ? { subject: "", url: null } : {}),
      };
    }),
    recentReviews: summary.recentReviews.map((review) => {
      const rule = repository(review.repository);
      return {
        ...review,
        repository: rule.name,
        ...(rule.redacted ? { title: "", url: null } : {}),
      };
    }),
    repositories: summary.repositories.map((status) => {
      const rule = repository(status.slug ?? status.key);
      return {
        ...status,
        key: status.key.startsWith("path:") ? rule.name : status.key,
        slug: rule.name,
        // Local checkout paths are never useful to the hosted dashboard.
        localPath: null,
        ...(rule.redacted
          ? { defaultRef: null, headSha: null, authorEmails: [] }
          : {}),
      };
    }),
    linear: {
      ...summary.linear,
      completedIssues: summary.linear.completedIssues.map((issue) => {
        const pullRequests = issue.pullRequests.map((pullRequest) => {
          const rule = repository(pullRequest.repository);
          return {
            ...pullRequest,
            repository: rule.name,
            ...(rule.redacted ? { title: "", url: null } : {}),
          };
        });
        const commits = issue.commits.map((commit) => {
          const rule = repository(commit.repository);
          return {
            ...commit,
            repository: rule.name,
            ...(rule.redacted ? { subject: "", url: null } : {}),
          };
        });
        const redactIssue =
          config.publish.redactLinearDetails ||
          issue.pullRequests.some((entry) => repository(entry.repository).redacted) ||
          issue.commits.some((entry) => repository(entry.repository).redacted);
        return {
          ...issue,
          pullRequests,
          commits,
          ...(redactIssue ? { title: "", url: null } : {}),
        };
      }),
    },
    warnings: summary.warnings.map((warning) => redactLocalPaths(warning, config.repositories)),
  };
}

export async function publishSnapshots(
  endpoint: string,
  token: string,
  publication: PublicationEnvelope,
  fetchImpl: FetchLike = fetch,
): Promise<PublishResult> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("The publish endpoint must use HTTPS.");
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("The publish endpoint must not contain credentials.");
  }
  if (token.length < 32) throw new Error(`${PUBLISH_TOKEN_ENV} must be at least 32 characters.`);
  if (!isPublicationEnvelope(publication)) {
    throw new Error("The publication does not match its schema or content id.");
  }

  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "overview-publisher/1",
    },
    body: JSON.stringify(publication),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body["error"] === "string"
      ? body["error"]
      : `HTTP ${response.status}`;
    throw new Error(`Publish failed: ${message}`);
  }
  if (
    !isRecord(body) ||
    typeof body["publishedAt"] !== "string" ||
    typeof body["alreadyCurrent"] !== "boolean"
  ) {
    throw new Error("Publish failed: the hosted application returned an invalid response.");
  }
  return { publishedAt: body["publishedAt"], alreadyCurrent: body["alreadyCurrent"] };
}

export function isPublicationEnvelope(value: unknown): value is PublicationEnvelope {
  if (!isRecord(value)) return false;
  if (value["schemaVersion"] !== PUBLICATION_SCHEMA_VERSION) return false;
  if (typeof value["publicationId"] !== "string" || !/^[a-f0-9]{64}$/.test(value["publicationId"])) {
    return false;
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "publicationId", "snapshots"])) return false;
  const snapshots = value["snapshots"];
  if (!isRecord(snapshots) || !hasOnlyKeys(snapshots, ["7", "30", "90"])) return false;
  if (!PUBLISHED_WINDOWS.every((days) => isSummary(snapshots[String(days)], days))) return false;
  return value["publicationId"] === publicationId(
    snapshots as unknown as PublicationEnvelope["snapshots"],
  );
}

function publicationId(snapshots: PublicationEnvelope["snapshots"]): string {
  const stable = Object.fromEntries(
    Object.entries(snapshots).map(([days, summary]) => {
      const { generatedAt: _generatedAt, publishedAt: _publishedAt, ...content } = summary;
      const { endIso: _endIso, ...stableWindow } = content.window;
      return [days, { ...content, window: stableWindow }];
    }),
  );
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function repositoryRule(repo: RepoConfig, index: number): RepositoryRule {
  const key = repo.githubRepo === undefined
    ? `path:${repo.path}`
    : `github:${repo.githubRepo.toLowerCase()}`;
  const publishedName = repo.githubRepo ?? `local-repository-${index + 1}`;
  return {
    names: new Set([key.toLowerCase(), repo.githubRepo?.toLowerCase() ?? key.toLowerCase()]),
    publishedName,
    redacted: repo.hostedDetail === "redacted",
  };
}

function redactLocalPaths(value: string, repositories: readonly RepoConfig[]): string {
  return repositories.reduce(
    (redacted, repo) => redacted.replaceAll(repo.path, "[local path]"),
    value,
  );
}

function isSummary(value: unknown, days: number): value is ActivitySummary {
  if (!isRecord(value) || typeof value["generatedAt"] !== "string") return false;
  const window = value["window"];
  const totals = value["totals"];
  const linear = value["linear"];
  return isRecord(window) && window["days"] === days &&
    isRecord(totals) && typeof totals["commitsAuthored"] === "number" &&
    Array.isArray(value["daily"]) && Array.isArray(value["landedPullRequests"]) &&
    Array.isArray(value["recentCommits"]) && Array.isArray(value["recentReviews"]) &&
    Array.isArray(value["repositories"]) && isRecord(linear) &&
    Array.isArray(linear["completedIssues"]);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
