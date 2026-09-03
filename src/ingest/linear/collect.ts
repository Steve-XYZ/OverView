/**
 * Turns the viewer's assigned Linear issues into domain records.
 *
 * One query over everything currently assigned to the viewer, paginated. There
 * is deliberately no `updatedAt` window here: filtering assigned issues by
 * recency would drop an older assigned issue a fresh database has never seen,
 * and a landed pull request naming it would then falsely count as unlinked.
 * The 7/30/90-day filtering lives in the metrics layer (`completedAt` in the
 * window), where it cannot corrupt the join. Kept separate from the git/GitHub
 * collectors — it knows Linear, knows no SQL, and never reads a pull request.
 */

import type { LinearIssueRecord, Provenance } from "../../domain/types.ts";
import { linearGraphql, type FetchImpl } from "./linearApi.ts";

const PAGE_SIZE = 50;

export interface LinearCollectionOptions {
  readonly apiKey: string;
  readonly syncRunId: number;
  readonly fetchImpl?: FetchImpl;
}

export interface LinearCollection {
  readonly issues: readonly LinearIssueRecord[];
  readonly warnings: readonly string[];
}

const ASSIGNED_QUERY = `
query AssignedIssues($after: String, $first: Int!) {
  viewer {
    assignedIssues(first: $first, after: $after) {
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
