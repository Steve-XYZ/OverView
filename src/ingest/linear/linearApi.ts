/**
 * Linear access over HTTPS with a personal API key from the local environment.
 *
 * No OAuth, no webhooks, no stored credential: the key lives in
 * `LINEAR_API_KEY`, is sent as the `Authorization` header Linear documents for
 * personal keys, and never touches the database. Without it, sync skips Linear
 * with a warning, the same way it skips GitHub when `gh` is missing.
 */

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_API_KEY_ENV = "LINEAR_API_KEY";

export class LinearError extends Error {}

/** The personal API key, or null when the user has not set one. */
export function linearApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[LINEAR_API_KEY_ENV];
  if (raw === undefined || raw.trim().length === 0) return null;
  return raw.trim();
}

export type FetchImpl = typeof fetch;

export async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: { apiKey?: string | null; fetchImpl?: FetchImpl } = {},
): Promise<T> {
  const apiKey = options.apiKey ?? linearApiKey();
  if (apiKey === null) {
    throw new LinearError(
      `No Linear API key. Set ${LINEAR_API_KEY_ENV} to a personal API key from ` +
        `Linear Settings > Security & access to sync Linear issues.`,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new LinearError(`Linear request failed: ${message(error)}`, { cause: error });
  }

  if (!response.ok) {
    const body = await safeBody(response);
    throw new LinearError(`Linear answered ${response.status}${body.length > 0 ? `: ${body}` : "."}`);
  }

  const parsed = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw new LinearError(`Linear GraphQL: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  if (parsed.data === undefined) throw new LinearError("Linear returned no data.");
  return parsed.data;
}

async function safeBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
