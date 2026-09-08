# Overview

A local-first dashboard that answers one question accurately: **what did I ship in the
last 7, 30 or 90 days?**

It reads your local git checkouts and the GitHub CLI you have already authenticated,
stores the result in a SQLite file on your machine, and serves one page on the
loopback interface. An optional hosted mirror can receive redacted normalized
records of that activity and compute any window from them; collection and company
credentials stay local.

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
| `publish [--endpoint <https-url>] [--snapshot-only]` | Redact and upload normalized records plus the 7/30/90-day summaries |
| `serve [--port N] [--host H]` | Serve the dashboard |

`sync` is idempotent. Every record is upserted on the source's own identifier, and
recent commit rows that are no longer reachable are removed. Rebases and squash merges
therefore replace prior history instead of accumulating it.

## Private hosted mirror

The hosted path is deliberately one-way:

```text
local Git / gh / Linear -> local SQLite -> facts -> redaction -> HTTPS publish
                                                             -> Vercel + Neon -> metrics
```

Vercel never receives GitHub or Linear credentials, source code, diffs, or raw
collector records. Nothing in the cloud can reach a repository, and no hosted code
calls GitHub or Linear.

The deployment holds accounts, not one shared dashboard. Each developer signs in with
GitHub, mints their own collector token, and sees only what their own collector
published. GitHub is used for identity alone: the authorize request asks for no
scopes, and the access token behind it is read once to learn your login and is never
stored.

### One summarizer, two stores

The hosted dashboard does not reimplement any metric. `metrics/summary.ts` exports a
pure `summarize(facts, window)`, and both sides call it:

```text
SQLite  -> store/facts.ts -> LedgerFacts -> summarize() -> local report
Neon    -> neonStore.ts   -> LedgerFacts -> summarize() -> hosted dashboard
```

`domain/facts.ts` defines the record shapes in the middle, and those shapes are also
the publication contract. A definition can only change in one place, so the hosted
7/30/90 numbers cannot drift from the local ones.

### What Neon stores

One row per account per record, keyed so that repeated publication updates in place.
Every table's primary key starts with `user_id`, so isolation comes from the key
rather than from each query remembering to filter. Every row also carries the
`collector_id` that last wrote it, which is what scopes deletion; see below.

| Table | Key after `user_id` | Holds |
|---|---|---|
| `overview_ledger_publication` | `collector_id` | One row per collector: coverage range, its time zone, identity login, last sync status and warnings |
| `overview_ledger_repository` | `repository_key` | Published repository identity, walked ref, head |
| `overview_ledger_repository_day` | `repository_key, day` | Commits observed and matched that local day, addresses seen |
| `overview_ledger_commit` | `sha` | One authored commit: timestamps, change volume, subject |
| `overview_ledger_pull_request` | `repository_key, number` | State, timestamps, change volume, merge commit |
| `overview_ledger_review` | `source_id` | One review submission |
| `overview_ledger_linear_issue` | `source_id` | A completed issue, its state and team |
| `overview_ledger_pull_request_link` | `repository_key, number, issue_identifier` | Which field named the issue |
| `overview_ledger_commit_link` | `sha, issue_identifier` | Subject evidence for a commit link |

A commit is keyed by SHA alone. The same commit reachable from a fork and its
upstream is one fact, which matches the local rule that a duplicate SHA counts once.
Per-repository counts still see both copies, through the per-day table, so the
"duplicate commit copy" warning survives the trip.

Timestamps are stored as epoch milliseconds and as the ISO text the collector wrote.
Neither becomes a `timestamptz`, because re-rendering a timestamp would change the
string the dashboard prints. For ad-hoc SQL, wrap the column:

```sql
SELECT to_timestamp(authored_at_ms / 1000.0) AS authored_at, subject
FROM overview_ledger_commit WHERE user_id = $1 ORDER BY authored_at_ms DESC LIMIT 20;
```

### The publication contract

`overview publish` sends one JSON document over HTTPS with a collector token in the
`Authorization` header. Version 2 carries five things:

- `schemaVersion: 2`.
- `publicationId`, a SHA-256 over the records and the covered days. The server
  recomputes it and refuses a body that does not match, so a truncated or spliced
  payload is rejected rather than half-stored.
- `coverage`, the range this publication restates in full.
- `facts`, the normalized records above.
- `snapshots`, the same three `ActivitySummary` objects version 1 carried.

Coverage runs back `max(sync.sinceDays, 90)` days, aligned to local midnight, and
forward to the moment of publication. Inside it the publication is the whole truth:
records it restates are updated, and records the account held that it no longer
mentions are deleted. That is how a rebase, a retitled pull request, or a reopened
issue reaches the hosted numbers. Outside coverage, earlier facts are left alone, so
the ledger keeps history the local database has since dropped.

Every record carries the current `publication_id`, which is what makes the two rules
above one mechanism: upsert everything received, then delete what is inside coverage
and still carries an older id. It is the same thing `deleteUnseenCommits` does to the
local database after a force-push. Removing a repository from your config deletes its
records at any age, mirroring the local `ON DELETE CASCADE`.

Republishing without syncing is a no-op in state and in what the response says
(`alreadyCurrent`, with the publication time held steady). On my own database a
180-day publication is 516 kB of the 3.5 MB limit, holding 390 commits, 343 pull
requests, 158 reviews and 580 repository-days across 24 repositories.

### One account, several collectors

An account can mint a token per machine, and each machine publishes whatever is in
its own config. That makes "delete what this publication did not mention" dangerous
if taken account-wide: a laptop watching two repositories would wipe the desktop's
four, because its publication is silent about them.

So authority is scoped to the credential. Facts stay owned by the account and
deduplicated by source identity, but every row records the `collector_id` that last
wrote it, and a publication may only delete rows carrying its own. Concretely:

- Two collectors with different repositories each correct their own half.
- A commit both machines can see is one row. Whichever published last owns it, and
  that machine's next publication is the one that can remove it. If it does, and the
  other machine still has the commit, the other machine's next publication restores
  it.
- Dropping a repository removes that collector's records for it, but the repository
  row itself survives while another collector still has facts filed under it, so a
  shared repository never loses the name its commits are displayed under.
- Diagnostics are per machine and the dashboard is one page, so they are merged: the
  newest publication sets the time zone, the sync line reports the most recent run,
  warnings are the union, and Linear counts as synced if any collector syncs it. A
  laptop without `LINEAR_API_KEY` cannot blank the section the desktop filled.
- Revoking a token does not delete what that collector published. The id is a label
  recording who last claimed a record, not an owner it depends on, and it carries no
  foreign key for that reason. Its publication row does go, so a machine you have
  revoked stops reporting its own sync time and Linear status for the account.

The transaction runs even when the content id is unchanged. A collector that
short-circuited could never take back ownership of a record another collector had
claimed, so a removal by that other collector would stand uncorrected. Re-running an
idempotent write is the cheaper mistake.

### Reconciliation

The local database is the oracle. Each publication carries both the facts and the
summaries the local collector computed from the same database, so the two can be
compared directly. Against my own 24 repositories, 13 of them redacted, the hosted
numbers derived from stored facts match the local redacted summaries exactly for 7,
30 and 90 days: 10/42/291 commits, 15/55/185 landed pull requests, 9/62/118 reviews.

Two checks keep it that way. `test/ledgerFacts.test.ts` asserts a commutation, that
redacting facts and then summarising gives the same object as summarising and then
redacting the summary, which is the property that makes the hosted dashboard
reproduce the local report by construction. `test/ledgerHosted.test.ts` publishes
through the real route and compares each window against the snapshot in the same
publication. You can run the same comparison against a live deployment, because
`/api/summary?source=snapshot` still serves the pre-ledger path:

```bash
curl -s --cookie "$COOKIE" 'https://your-overview.vercel.app/api/summary?days=30&source=ledger'
curl -s --cookie "$COOKIE" 'https://your-overview.vercel.app/api/summary?days=30&source=snapshot'
```

Each response names the store it came from in a `source` field. The dashboard reads
whichever is available, preferring the ledger.

### Fallback and migration

There is no flag day. The first `overview publish` after this change writes both the
ledger and the snapshot row, in one transaction, and creates the tables it needs on
first use. Until then, an account that has only ever published version 1 keeps
reading its snapshot.

- A version 1 publication is still accepted, so an older collector keeps working.
- `overview publish --snapshot-only` sends version 1 deliberately.
- `GET /api/summary` prefers the ledger and falls back to the snapshot.
- `?source=snapshot` forces the old path; `?source=ledger` returns 404 when no facts
  have been published, rather than silently answering from the snapshot.

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
review titles, ref/head details, and observed author emails. `redactLinearDetails:
true` clears every Linear title and URL. Local paths and identity Git emails are
never published, even for detailed repositories. Redaction happens before
serialization, so a cleared field never reaches Neon at all. Local reports and the
loopback dashboard retain full detail.

Two things about the fact ledger are worth knowing before you publish one.

**A Linear issue's title is now judged once, not per window.** Previously the
publisher blanked an issue's title when the window on screen contained a redacted
repository's contribution to it. A stored fact has no window, so the rule became: if
any of your published work on a redacted repository names the issue, its title and
URL are never published. That redacts strictly more than before, and it closes the
hole where a title reached the database as soon as the window moved.

**Per-day observed volume covers other people's commits.** The dashboard's
"yours / all" column and the addresses column are aggregates over everybody who
committed to your repositories. To answer a range nobody asked for at publication
time, those aggregates are published per repository per local day rather than per
window. For a redacted repository that means a daily count of total activity leaves
your machine where previously a single per-window count did. Author addresses stay
empty for a redacted repository, as before, and no per-commit record for another
person is ever published.

Verified against my own configuration: of 202 redacted repository-days, all carry
zero addresses; of 284 redacted commits, all have an empty subject and a null URL; of
303 redacted pull requests, all have an empty title and a null URL; and
`collector.identity.gitEmails` is empty while `gitEmailsConfigured` stays true so the
hosted dashboard can still show the "no git emails configured" warning.

### Deploy Vercel and Neon

1. Create a small Neon Postgres database and copy its pooled connection string.
2. Register a GitHub OAuth app (Settings → Developer settings → OAuth Apps). Set the
   homepage to your Vercel URL and the authorization callback to
   `https://your-overview.vercel.app/api/auth/github/callback`. Request no scopes;
   OverView asks for none. Copy the client ID and generate a client secret.
3. Import this repository into Vercel as an "Other" project. `vercel.json` supplies
   the pnpm build command, static rewrites, and security headers.
4. Add these Vercel environment variables for Production. Use independent values:

   - `DATABASE_URL` — the Neon pooled connection string.
   - `OVERVIEW_SESSION_SECRET` — a random value, at least 32 characters.
   - `OVERVIEW_GITHUB_CLIENT_ID` — from the OAuth app.
   - `OVERVIEW_GITHUB_CLIENT_SECRET` — from the OAuth app.
   - `OVERVIEW_ALLOWED_GITHUB_LOGINS` — optional, comma separated. When set, only
     those logins may hold an account. When unset, anyone with a GitHub account can
     sign in and gets an empty dashboard of their own.

   Generate the session secret with `openssl rand -hex 32`. Do not prefix any secret
   with `NEXT_PUBLIC_` or commit it to a file. The first hosted request creates the
   account, token, snapshot, and `overview_ledger_*` tables in one transaction.

An earlier single-user deployment also has an `overview_published_snapshot` table.
Accounts neither read nor drop it; publish once under an account to repopulate.

### Onboard a developer

Everything below is done by the developer whose data it is. Nobody needs access to
anyone else's machine, and no administrator hands out a credential.

1. **Sign in.** Open the Vercel URL and choose *Continue with GitHub*.
2. **Mint a collector token.** Go to *Account*, name the machine, and press
   *Create token*. The token is shown once and stored only as a SHA-256 digest; it is
   scoped to that one account and cannot open a dashboard. Create one per machine and
   revoke it if the machine is lost.
3. **Configure the CLI**, using the two exported lines the page shows:

```bash
node dist/cli.js init --repo ~/src/one-repo --repo ~/src/another
export OVERVIEW_PUBLISH_TOKEN='ovp_...'
export OVERVIEW_PUBLISH_URL='https://your-overview.vercel.app/api/publish'
```

4. **Check `identity.gitEmails`** in `overview.config.json`, and mark work
   repositories `"hostedDetail": "redacted"` before publishing anything.
5. **Sync and publish.**

```bash
node dist/cli.js sync
node dist/cli.js publish
```

6. **Read the dashboard.** The Vercel URL now shows that account's summaries and no
   one else's.

Dashboard access uses a signed, 30-day, `Secure`, `HttpOnly`, `SameSite=Lax` cookie
naming one account; it does not accept a collector token. The publish API accepts only
a collector token, resolves it to the account that created it, and cannot open a
dashboard session.

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
came from `pr_title` or `pr_branch`. Published records keep `source_url` and
`recorded_at` where redaction allows, plus the `publication_id` that last restated
them, so a hosted figure traces back to one publication.

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
  domain/     Provider-neutral records, the fact contract, time helpers. Depends on nothing.
  config/     Load and validate overview.config.json.
  ingest/
    git/      Local checkout -> CommitRecord. Knows git; knows no SQL.
    github/   `gh api graphql` -> PullRequestRecord, ReviewRecord.
    linear/   `api.linear.app` with LINEAR_API_KEY -> LinearIssueRecord. Separate collector.
    sync.ts   Decides what to run and hands records to the write layer.
  store/      SQLite. writes.ts is the only path in; reads.ts the only path out.
              facts.ts turns rows into the records metrics consume.
  metrics/    Windows, statistics, and summarize(facts, window) for both stores.
  publish/    Redact facts, build the versioned publication, send it over HTTPS.
  hosted/     Hosted accounts and the fact ledger: sessions, collector tokens, GitHub
              identity, routes, the HostedStore contract and its Neon implementation.
  server/     Loopback HTTP: /api/summary and the static page.
  web/        The dashboard. Its only contract is the ActivitySummary JSON.
api/          Vercel functions: GitHub sign-in, publish, authenticated read,
              collector tokens, and sign-out. Thin wiring over hosted/routes.ts.
middleware.ts Protects hosted pages, summary data and tokens with the session.
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
- **A publication only corrects its own coverage.** Records older than
  `max(sync.sinceDays, 90)` days are kept but never revised, so a correction to work
  older than that never reaches the hosted ledger. The published windows are all
  inside coverage, so they always agree with the local report.
- **A checkout with no GitHub remote is published under its position in the config.**
  It appears as `local-repository-2` for the second entry. Reordering or removing an
  earlier entry renumbers it; the records under the old alias are deleted rather than
  double-counted, but facts older than coverage are not carried across. Setting
  `githubRepo` avoids this.
- **Two collectors publishing at the same instant race.** Each publication is one
  transaction, so the ledger stays consistent, but the read-then-write that decides
  `alreadyCurrent` is not atomic; simultaneous publications from the same machine can
  both do the work. Staggered timers avoid it.
- **The snapshot fallback holds one publication per account, not one per collector.**
  With several collectors, `?source=snapshot` shows whichever published last. The
  ledger is the correct view; the snapshot is there for comparison during validation.
- **The hosted SQL itself is not exercised in CI.** There is no Postgres in the test
  environment, so the ledger tests run against an in-memory store that mirrors the
  same keys and lifetime rules. Reads, writes, and metrics are covered; the SQL text
  is not.
- **Accounts cannot be deleted from the UI.** Removing one means deleting its
  `overview_user` row, which cascades to its tokens and snapshot.

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
