/**
 * Turns one GitHub repository into pull-request and review records.
 *
 * Both collectors use the search API windowed on `updated:`, which is a superset of
 * "created in the window" and "merged in the window" — a merge updates the pull
 * request, so a PR opened long ago but landed yesterday is still returned.
 */

import type {
  Provenance,
  PullRequestRecord,
  PullRequestState,
  ReviewRecord,
  ReviewState,
} from "../../domain/types.ts";
import { graphql } from "./ghCli.ts";

/** GitHub's search API stops at 1000 results per query, whatever the page size. */
const SEARCH_RESULT_CAP = 1000;
const PAGE_SIZE = 50;

export interface GithubCollectionOptions {
  readonly login: string;
  /** `YYYY-MM-DD` lower bound handed to the search qualifier. */
  readonly sinceDay: string;
  readonly syncRunId: number;
}

export interface GithubCollection {
  readonly pullRequests: readonly PullRequestRecord[];
  readonly reviews: readonly ReviewRecord[];
  readonly warnings: readonly string[];
}

const PR_FIELDS = `
  id
  number
  title
  url
  state
  isDraft
  createdAt
  mergedAt
  closedAt
  updatedAt
  additions
  deletions
  changedFiles
  baseRefName
  mergeCommit { oid }
  author { login }
  repository { nameWithOwner }`;

const AUTHORED_QUERY = `
query($q: String!, $cursor: String, $pageSize: Int!) {
  search(query: $q, type: ISSUE, first: $pageSize, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

const REVIEWED_QUERY = `
query($q: String!, $cursor: String, $pageSize: Int!, $login: String!) {
  search(query: $q, type: ISSUE, first: $pageSize, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        ${PR_FIELDS}
        reviews(first: 50, author: $login) {
          nodes { id state submittedAt url author { login } }
        }
      }
    }
  }
}`;

interface SearchNode {
  readonly id?: string;
  readonly number?: number;
  readonly title?: string;
  readonly url?: string;
  readonly state?: string;
  readonly isDraft?: boolean;
  readonly createdAt?: string;
  readonly mergedAt?: string | null;
  readonly closedAt?: string | null;
  readonly updatedAt?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly baseRefName?: string | null;
  readonly mergeCommit?: { oid: string } | null;
  readonly author?: { login: string } | null;
  readonly repository?: { nameWithOwner: string } | null;
  readonly reviews?: {
    nodes: ({
      id: string;
      state: string;
      submittedAt: string | null;
      url: string;
      author: { login: string } | null;
    } | null)[];
  };
}

interface SearchPage {
  readonly search: {
    readonly issueCount: number;
    readonly pageInfo: { hasNextPage: boolean; endCursor: string | null };
    readonly nodes: (SearchNode | null)[];
  };
}

export async function collectFromGithub(
  slug: string,
  options: GithubCollectionOptions,
): Promise<GithubCollection> {
  const warnings: string[] = [];
  const recordedAt = new Date().toISOString();
  const repositoryKey = `github:${slug.toLowerCase()}`;

  const pullRequests = new Map<string, PullRequestRecord>();
  const reviews: ReviewRecord[] = [];

  const authored = await searchAll(
    AUTHORED_QUERY,
    `repo:${slug} is:pr author:${options.login} updated:>=${options.sinceDay}`,
    {},
    warnings,
    `pull requests authored in ${slug}`,
  );
  for (const node of authored) {
    const record = toPullRequest(node, repositoryKey, recordedAt, options.syncRunId);
    if (record !== null) pullRequests.set(record.provenance.sourceId, record);
  }

  const reviewed = await searchAll(
    REVIEWED_QUERY,
    `repo:${slug} is:pr reviewed-by:${options.login} updated:>=${options.sinceDay}`,
    { login: options.login },
    warnings,
    `pull requests reviewed in ${slug}`,
  );
  for (const node of reviewed) {
    // Keep the reviewed pull request too: a review row is only meaningful when the
    // pull request it points at is also on disk.
    const record = toPullRequest(node, repositoryKey, recordedAt, options.syncRunId);
    if (record !== null && !pullRequests.has(record.provenance.sourceId)) {
      pullRequests.set(record.provenance.sourceId, record);
    }
    reviews.push(
      ...toReviews(node, repositoryKey, options.login, recordedAt, options.syncRunId),
    );
  }

  return { pullRequests: [...pullRequests.values()], reviews, warnings };
}

async function searchAll(
  query: string,
  searchQuery: string,
  extraVariables: Record<string, unknown>,
  warnings: string[],
  label: string,
): Promise<SearchNode[]> {
  const nodes: SearchNode[] = [];
  let cursor: string | null = null;
  let total = 0;

  for (;;) {
    const page: SearchPage = await graphql<SearchPage>(query, {
      q: searchQuery,
      cursor,
      pageSize: PAGE_SIZE,
      ...extraVariables,
    });
    total = page.search.issueCount;
    for (const node of page.search.nodes) if (node !== null) nodes.push(node);

    if (!page.search.pageInfo.hasNextPage) break;
    if (nodes.length >= SEARCH_RESULT_CAP) break;
    cursor = page.search.pageInfo.endCursor;
    if (cursor === null) break;
  }

  if (total > SEARCH_RESULT_CAP) {
    warnings.push(
      `${label}: GitHub search reports ${total} matches but caps results at ` +
        `${SEARCH_RESULT_CAP}. Narrow sync.sinceDays to see them all.`,
    );
  }
  return nodes;
}

function toPullRequest(
  node: SearchNode,
  repositoryKey: string,
  recordedAt: string,
  syncRunId: number,
): PullRequestRecord | null {
  if (node.id === undefined || node.number === undefined || node.createdAt === undefined) {
    return null;
  }
  const provenance: Provenance = {
    sourceSystem: "github",
    sourceId: node.id,
    sourceUrl: node.url ?? null,
    recordedAt,
    syncRunId,
  };
  return {
    repositoryKey,
    number: node.number,
    title: node.title ?? "",
    state: normaliseState(node.state),
    isDraft: node.isDraft ?? false,
    authorLogin: node.author?.login ?? null,
    createdAt: node.createdAt,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    updatedAt: node.updatedAt ?? node.createdAt,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    baseRef: node.baseRefName ?? null,
    mergeCommitSha: node.mergeCommit?.oid ?? null,
    provenance,
  };
}

function toReviews(
  node: SearchNode,
  repositoryKey: string,
  login: string,
  recordedAt: string,
  syncRunId: number,
): ReviewRecord[] {
  if (node.id === undefined || node.number === undefined) return [];
  const out: ReviewRecord[] = [];

  for (const review of node.reviews?.nodes ?? []) {
    if (review === null) continue;
    // A review with no submitted timestamp is still a pending draft; it has not happened yet.
    if (review.submittedAt === null) continue;
    if (review.author?.login.toLowerCase() !== login.toLowerCase()) continue;

    out.push({
      repositoryKey,
      pullRequestSourceId: node.id,
      pullRequestNumber: node.number,
      reviewerLogin: login,
      state: normaliseReviewState(review.state),
      submittedAt: review.submittedAt,
      provenance: {
        sourceSystem: "github",
        sourceId: review.id,
        sourceUrl: review.url,
        recordedAt,
        syncRunId,
      },
    });
  }
  return out;
}

function normaliseState(state: string | undefined): PullRequestState {
  return state === "MERGED" || state === "CLOSED" ? state : "OPEN";
}

function normaliseReviewState(state: string): ReviewState {
  switch (state) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "COMMENTED":
    case "DISMISSED":
    case "PENDING":
      return state;
    default:
      return "COMMENTED";
  }
}
