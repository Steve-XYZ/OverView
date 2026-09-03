/**
 * Turns the viewer's assigned Linear issues into domain records.
 *
 * One query, windowed on `updatedAt`: anything created, completed, or touched
 * since the sync window opened. That window matches the git/GitHub retention
 * (`sync.sinceDays`), so the 7/30/90-day dashboard windows always read from
 * synced data. Kept separate from the git/GitHub collectors — it knows Linear,
 * knows no SQL, and never reads a pull request.
 */

import type { LinearIssueRecord, Provenance } from "../../domain/types.ts";
import { linearGraphql, type FetchImpl } from "./linearApi.ts";

const PAGE_SIZE = 50;

export interface LinearCollectionOptions {
  readonly apiKey: string;
  /** Full ISO lower bound handed to the `updatedAt` filter. */
  readonly sinceIso: string;
  readonly syncRunId: number;
  readonly fetchImpl?: FetchImpl;
}

export interface LinearCollection {
  readonly issues: readonly LinearIssueRecord[];
  readonly warnings: readonly string[];
}

const ASSIGNED_QUERY = `
query AssignedIssues($after: String, $first: Int!, $filter: IssueFilter) {
  viewer {
    assignedIssues(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        identifier
        title
        url
        createdAt
        updatedAt
        completedAt
        state { name type }
        team { key name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface IssueNode {
  readonly id?: string;
  readonly identifier?: string;
  readonly title?: string | null;
  readonly url?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly completedAt?: string | null;
  readonly state?: { name?: string; type?: string } | null;
  readonly team?: { key?: string } | null;
}

interface AssignedPage {
  readonly viewer: {
    readonly assignedIssues: {
      readonly nodes: (IssueNode | null)[];
      readonly pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

export async function collectFromLinear(
  options: LinearCollectionOptions,
): Promise<LinearCollection> {
  const warnings: string[] = [];
  const recordedAt = new Date().toISOString();
  const issues: LinearIssueRecord[] = [];
  let cursor: string | null = null;

  for (;;) {
    const graphqlOptions: { apiKey: string; fetchImpl?: FetchImpl } = { apiKey: options.apiKey };
    if (options.fetchImpl !== undefined) graphqlOptions.fetchImpl = options.fetchImpl;
    const page: AssignedPage = await linearGraphql<AssignedPage>(
      ASSIGNED_QUERY,
      {
        after: cursor,
        first: PAGE_SIZE,
        filter: { updatedAt: { gte: options.sinceIso } },
      },
      graphqlOptions,
    );

    for (const node of page.viewer.assignedIssues.nodes) {
      if (node === null) continue;
      const record = toLinearIssue(node, recordedAt, options.syncRunId);
      if (record !== null) issues.push(record);
    }

    if (!page.viewer.assignedIssues.pageInfo.hasNextPage) break;
    cursor = page.viewer.assignedIssues.pageInfo.endCursor;
    if (cursor === null) break;
  }

  return { issues, warnings };
}

/** Normalise one GraphQL node. Null when it lacks the keys the dashboard joins on. */
export function toLinearIssue(
  node: IssueNode,
  recordedAt: string,
  syncRunId: number,
): LinearIssueRecord | null {
  if (node.id === undefined || node.identifier === undefined) return null;
  if (node.createdAt === undefined || node.updatedAt === undefined) return null;
  const provenance: Provenance = {
    sourceSystem: "linear",
    sourceId: node.id,
    sourceUrl: node.url ?? null,
    recordedAt,
    syncRunId,
  };
  return {
    identifier: node.identifier.toUpperCase(),
    title: node.title ?? "",
    stateName: node.state?.name ?? "Unknown",
    stateType: node.state?.type ?? "unknown",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    completedAt: node.completedAt ?? null,
    teamKey: node.team?.key ?? null,
    provenance,
  };
}
