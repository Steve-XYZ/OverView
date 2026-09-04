# Overview

A local-first dashboard that answers one question accurately: **what did I ship in the
last 7, 30 or 90 days?**

It reads your local git checkouts and the GitHub CLI you have already authenticated,
stores the result in a SQLite file on your machine, and serves one page on the
loopback interface. An optional hosted mirror can receive redacted, already-computed
dashboard summaries; collection and company credentials stay local.

## Requirements

- Node 24 or newer (for `node:sqlite` and native TypeScript execution)
- pnpm 11 (`corepack enable` installs the version pinned by `packageManager`)
- `git`
- `gh`, authenticated (`gh auth login`) — optional; without it you get commits only
- `LINEAR_API_KEY` in the environment — optional; without it you get no Linear issues

The local collector path has no runtime package dependency. The hosted functions use
only the Neon serverless driver and Vercel's middleware helpers.

## Quick start

```bash
pnpm install
pnpm build

node dist/cli.js init --repo ~/src/one-repo --repo ~/src/another
node dist/cli.js sync
node dist/cli.js report --days 30
node dist/cli.js serve            # http://127.0.0.1:4317
```

`init` detects your GitHub login from `gh` and your commit emails from git config.
**Check `identity.gitEmails` before trusting any number** — it is the single largest
source of wrong counts. If you commit under a work address, a personal address and a
GitHub noreply address, all three belong in that list.

For the Linear slice, create a personal API key in Linear Settings → Security &
access and export it before syncing. The key is sent as the `Authorization`
header, never stored, and never leaves your machine except to `api.linear.app`:

```bash
export LINEAR_API_KEY=lin_api_...
node dist/cli.js sync
```

## Commands

| Command | What it does |
|---|---|
| `init [--repo <path>]...` | Write `overview.config.json`, detecting identity |
| `repo add <path> [--github owner/name] [--branch main]` | Add a repository |
| `repo list` | Show what is configured |
| `sync [--days N] [--only <text>] [--no-github] [--no-linear]` | Ingest into the local database |
| `report [--days N] [--json]` | Print the metrics |
| `publish [--endpoint <https-url>]` | Redact and upload the current 7/30/90-day summaries |
| `serve [--port N] [--host H]` | Serve the dashboard |

`sync` is idempotent. Every record is upserted on the source's own identifier, and
recent commit rows that are no longer reachable are removed. Rebases and squash merges
therefore replace prior history instead of accumulating it.

## Private hosted mirror

The hosted path is deliberately one-way:

```text
local Git / gh / Linear -> local SQLite -> metrics -> redaction -> HTTPS publish
                                                               -> Vercel + Neon
```

Vercel never receives GitHub or Linear credentials, source code, diffs, or raw
collector records. Neon stores one current JSONB publication containing the 7, 30,
and 90-day `ActivitySummary` objects plus a schema version, content ID, and server
publication time. Publishing the same content again is a no-op, while newer content
replaces the singleton row. A failed request does not write to SQLite.

### Configure redaction

Mark each private/work repository explicitly. Repositories default to `detailed` so
existing configs keep their behavior:

```json
{
  "repositories": [
    {
      "path": "~/src/work-project",
      "githubRepo": "company/work-project",
      "hostedDetail": "redacted"
    }
  ],
  "publish": {
    "endpoint": "https://your-overview.vercel.app/api/publish",
    "redactLinearDetails": true
  }
}
```

For a redacted repository, the publisher keeps metric totals, repository identifier,
PR number, issue identifier, and commit SHA, but clears URLs, commit subjects, PR and
review titles, ref/head details, and observed author emails. It also clears a Linear
issue's title and URL when that issue links to a redacted repository.
`redactLinearDetails: true` clears every Linear title and URL, including issues with
no repository contribution in the current window. Local paths and identity Git emails
are never published, even for detailed repositories. These changes apply only to the
copied payload; local reports and the loopback dashboard retain full detail.

### Deploy Vercel and Neon

1. Create a small Neon Postgres database and copy its pooled connection string.
2. Import this repository into Vercel as an “Other” project. `vercel.json` supplies
   the pnpm build command, static rewrites, and security headers.
3. Add these Vercel environment variables for Production. Use independent values:

   - `DATABASE_URL` — the Neon pooled connection string.
   - `OVERVIEW_PUBLISH_TOKEN` — a random publish-only token, at least 32 characters.
   - `OVERVIEW_DASHBOARD_PASSWORD` — a strong, unique password entered on your phone.
   - `OVERVIEW_SESSION_SECRET` — a separate random value, at least 32 characters.

   Generate the random token and session secret with `openssl rand -hex 32`. Do not
   prefix any secret with `NEXT_PUBLIC_` or commit it to a file. The first hosted
   request creates the single `overview_published_snapshot` table automatically.
4. Deploy, then set the matching publish token only in the local environment:

```bash
export OVERVIEW_PUBLISH_TOKEN='the-random-publish-token'
# Optional instead of publish.endpoint in overview.config.json:
export OVERVIEW_PUBLISH_URL='https://your-overview.vercel.app/api/publish'

node dist/cli.js sync
node dist/cli.js publish
```

Open the Vercel HTTPS URL on your phone and sign in. Dashboard access uses a signed,
30-day, `Secure`, `HttpOnly`, `SameSite=Lax` cookie; it does not accept the publish
token. The publish API accepts only the bearer token and cannot create a dashboard
session.

The command below is ready to place in a local cron or systemd timer when desired;
OverView itself does not schedule or collect anything in the cloud:

```bash
cd /path/to/overview && node dist/cli.js sync && node dist/cli.js publish
```

## What the numbers mean

Precision here matters more than breadth, so each metric states its rule. The
dashboard repeats these definitions at the bottom of the page.

- **Commits authored** — non-merge commits you authored that are reachable from the
  repository's default branch, counted by **author date**. Merge commits are excluded;
  they carry no authored change and would double-count the branch they merge. An
  identical SHA seen in an upstream repository and a configured fork counts once.
- **Active days** — local calendar days with at least one commit you **authored** (by
  author date, which survives a rebase), pull request you opened or landed, or review
  you submitted.
- **Pull requests opened / landed** — counted on creation date and merge date
  respectively, for pull requests **you** opened. The two are deliberately separate:
  a pull request opened in July and merged yesterday counts as landed, not opened.
- **Reviews given** — review submissions by you. Two rounds on one pull request count
  as two reviews; the tile's subtitle shows the distinct pull requests.
- **Change volume** — added and deleted lines over the counted commits, after removing
  paths matching `excludePaths`. Removed churn is reported in its own tile rather than
  discarded, so a lockfile refresh never inflates the number and never disappears
  silently either.
- **Time to merge** — hours from creation to merge, reported as **median and p75, never
  a mean**. The distribution has a long tail; one pull request that sat over a holiday
  would drag a mean away from anything you experienced.
- **Linear completed** — Linear issues assigned to you, counted on the day they
  entered a completed state. Only synced issues appear, so setting
  `LINEAR_API_KEY` is what makes this tile non-empty.
- **PR coverage** — share of your landed pull requests in the window whose title or
  source branch names a synced Linear issue (for example `BOS-2422`). A pull
  request only counts as linked when the identifier matches an issue already in
  the database, and each link keeps whether it came from the title or the
  branch. Commits link the same way through their subject, or as the squash
  commit of a linked pull request.

A window of N days is the N local calendar days ending today, today included, so
"17 / 30 active days" compares like with like. Bucketing uses your local zone, not UTC.

## Provenance

Every stored record carries `source_system`, `source_id` (a commit sha or GitHub node
id), `source_url`, `recorded_at` and the `sync_run_id` that fetched it. The
`repository` table records the ref actually walked and the head it saw, so a stale
`origin/main` is visible rather than silent. The `sync_run` table keeps one row per
run with its counts and warnings. Commit rows retain both author and committer dates.
Linear issues live in `linear_issue` with the same provenance columns; the human
identifier (`BOS-2422`) is the join key, and pull-request links keep whether they
came from `pr_title` or `pr_branch`.

That means any figure on the dashboard can be reconstructed from the database:

```sql
-- Which commits produced "commits authored" for the last 7 days?
SELECT r.slug, c.sha, c.authored_at, c.committed_at, c.subject, c.source_url
FROM commit_event c JOIN repository r ON r.id = c.repository_id
WHERE c.is_merge = 0
  AND c.author_email IN ('you@example.com')
  AND c.authored_at_ms >= (unixepoch('now', '-7 days') * 1000)
ORDER BY c.authored_at_ms DESC;
```

## Layout

```
src/
  domain/     Provider-neutral records and time helpers. Depends on nothing.
  config/     Load and validate overview.config.json.
  ingest/
    git/      Local checkout -> CommitRecord. Knows git; knows no SQL.
    github/   `gh api graphql` -> PullRequestRecord, ReviewRecord.
    linear/   `api.linear.app` with LINEAR_API_KEY -> LinearIssueRecord. Separate collector.
    sync.ts   Decides what to run and hands records to the write layer.
  store/      SQLite. writes.ts is the only path in; reads.ts the only path out.
  metrics/    Windows, statistics, and the summary the dashboard eats.
  publish/    Build 7/30/90 summaries, redact them, and send the HTTPS publication.
  hosted/     Shared hosted authentication and the Neon singleton snapshot store.
  server/     Loopback HTTP: /api/summary and the static page.
  web/        The dashboard. Its only contract is the ActivitySummary JSON.
api/          Vercel publish, authenticated read, login, and logout functions.
middleware.ts Protects hosted pages and summary data with the dashboard session.
```

The boundaries are one-directional: `ingest` and `metrics` both depend on `domain` and
`store`, never on each other; `web` depends only on the JSON shape. Linear follows
the same rule: its collector produces records, and the deterministic title/branch
join lives in `domain/linear.ts` so metrics can use it without importing ingestion.
That is what makes the likely next steps additive rather than a rewrite:

- **Another provider** (GitLab, Linear) — add a collector under `ingest/` producing the
  same records and a branch in `sync.ts`. Nothing else changes.
- **Postgres as the local source of truth** — reimplement `store/writes.ts` and
  `store/reads.ts` against a new driver. The hosted Neon table is only a mirror and
  does not change this boundary.
- **A GitHub App instead of `gh`** — replace `ingest/github/ghCli.ts`. The collector
  above it parses GraphQL responses, not CLI output.

There is no plugin system, queue, metric registry, tenancy, cloud collector, GitHub
App, or Linear OAuth flow.

## Known limits

- **Reviews and pull requests only come from configured repositories.** A review you
  gave on a repository you have not added is invisible.
- **GitHub search caps at 1000 results per query.** The sync warns when it hits the cap.
- **A local checkout can be stale.** By default nothing touches the network for git;
  set `sync.fetchBeforeSync` to `true` to fetch first. The dashboard shows the ref and
  head it walked so you can tell.
- **A shallow checkout has incomplete history.** Sync uses the commits it can reach and
  emits a warning so low counts are not silent.
- **An initial import inflates change volume.** A first commit of 14,000 lines is
  counted as 14,000 lines, because that is what happened.
- **Only pull requests you opened count as landed.** Work merged by someone else on
  your behalf shows up as commits, not as a landed pull request.
- **`gh` search is rate-limited** to roughly 30 queries a minute. Sync makes two per
  repository and runs them sequentially.
- **Linear syncs everything currently assigned to you**, with no recency window:
  filtering by `updatedAt` would drop an older assigned issue on a fresh database
  and falsely report its landed PR as unlinked. The 7/30/90-day filtering happens
  in the metrics layer on `completedAt`. Without `LINEAR_API_KEY` the Linear
  section is empty and the sync warns rather than fails; pass `--no-linear` to
  silence even that.
- **Links need an explicit issue key.** A pull request links when its title or
  source branch names a synced issue (`BOS-2422` in either, case-insensitive;
  `-`, `/` and `_` all count as separators, so `BOS-2422_fix` links too);
  a commit links through its subject or as the squash commit of a linked PR.
  Mentions of unknown identifiers never link, and pull requests synced before
  this slice have no branch stored, so they link on title alone until resynced.
- **Per-issue contributions are window-scoped.** A completed issue lists the
  landed PRs and authored commits from the same dashboard window that named it;
  work outside the window does not appear under it.

## Development

```bash
pnpm typecheck        # tsc over src and test
pnpm typecheck:hosted # tsc over Vercel functions and middleware
pnpm test             # node:test, no build required
pnpm check            # all typechecks and tests
pnpm build            # tsc + copy the page assets into dist/web
pnpm build:hosted     # build local output and Vercel public assets
node src/cli.ts sync  # run from source via Node's TypeScript support
```

Source runs unbuilt because the code stays inside erasable TypeScript syntax
(`erasableSyntaxOnly`), which Node can strip without a compiler. The browser still
needs real JavaScript, so `serve` looks for `dist/` and says so when it is missing.
