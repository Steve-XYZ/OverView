/**
 * GitHub access through the `gh` CLI the user has already authenticated.
 *
 * Shelling out to `gh` rather than holding a token means this tool never stores a
 * credential and inherits whatever auth the user already trusts. The cost is a
 * process per request, which is irrelevant at one developer's volume.
 */

import { run } from "../exec.ts";

export class GithubError extends Error {}

export async function ghAvailable(): Promise<boolean> {
  const result = await run("gh", ["--version"], { timeoutMs: 10_000 });
  return result.code === 0;
}

export async function ghAuthenticated(): Promise<boolean> {
  const result = await run("gh", ["auth", "status"], { timeoutMs: 20_000 });
  return result.code === 0;
}

/** The login `gh` is currently authenticated as. */
export async function viewerLogin(): Promise<string> {
  const data = await graphql<{ viewer: { login: string } }>(
    "query { viewer { login } }",
    {},
  );
  return data.viewer.login;
}

export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const result = await run("gh", ["api", "graphql", "--input", "-"], {
    stdin: JSON.stringify({ query, variables }),
    timeoutMs: 60_000,
  });

  if (result.code !== 0) {
    throw new GithubError(
      `gh api graphql failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  const parsed = JSON.parse(result.stdout) as { data?: T; errors?: { message: string }[] };
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw new GithubError(`GraphQL: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  if (parsed.data === undefined) throw new GithubError("GraphQL returned no data.");
  return parsed.data;
}
