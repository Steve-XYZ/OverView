/**
 * The collector-token page. Its only contract with the server is `/api/tokens`,
 * which is session-authenticated and scoped to the signed-in account.
 */

interface TokenRecord {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

interface TokenList {
  readonly githubLogin: string;
  readonly tokens: readonly TokenRecord[];
}

void refresh();

byId("create").addEventListener("submit", (event) => {
  event.preventDefault();
  void create();
});

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/tokens");
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    const list = (await response.json()) as TokenList;
    byId("who").textContent = `Signed in as ${list.githubLogin}`;
    renderTokens(list.tokens);
    hideError();
  } catch (error) {
    showError(`Could not load your tokens: ${describe(error)}`);
  }
}

async function create(): Promise<void> {
  const input = byId("name") as HTMLInputElement;
  try {
    const response = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: input.value.trim() }),
    });
    const body = (await response.json()) as { token?: string; error?: string };
    if (!response.ok || typeof body.token !== "string") {
      throw new Error(body.error ?? `The server answered ${response.status}.`);
    }
    input.value = "";
    showFreshToken(body.token);
    hideError();
    await refresh();
  } catch (error) {
    showError(`Could not create a token: ${describe(error)}`);
  }
}

async function revoke(id: string): Promise<void> {
  try {
    const response = await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    hideError();
    await refresh();
  } catch (error) {
    showError(`Could not revoke that token: ${describe(error)}`);
  }
}

function renderTokens(tokens: readonly TokenRecord[]): void {
  const body = byId("tokens");
  body.textContent = "";
  if (tokens.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No tokens yet. Create one to publish from a machine.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const token of tokens) {
    const row = document.createElement("tr");
    row.append(
      cell(token.name),
      cell(`${token.prefix}…`),
      cell(formatDate(token.createdAt)),
      cell(token.lastUsedAt === null ? "never" : formatDate(token.lastUsedAt)),
    );

    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Revoke";
    button.addEventListener("click", () => void revoke(token.id));
    action.append(button);
    row.append(action);
    body.append(row);
  }
}

function showFreshToken(token: string): void {
  byId("fresh-commands").textContent = [
    `export OVERVIEW_PUBLISH_TOKEN='${token}'`,
    `export OVERVIEW_PUBLISH_URL='${window.location.origin}/api/publish'`,
    "",
    "node dist/cli.js sync",
    "node dist/cli.js publish",
  ].join("\n");
  byId("fresh").hidden = false;
}

function cell(text: string): HTMLTableCellElement {
  const element = document.createElement("td");
  element.textContent = text;
  return element;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function showError(message: string): void {
  const element = byId("error");
  element.textContent = message;
  element.hidden = false;
}

function hideError(): void {
  byId("error").hidden = true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id} in the account page.`);
  return element;
}
