/**
 * SQLite schema.
 *
 * Migrations are an ordered list of statements applied once and recorded in
 * `schema_migration`. That is enough for a single-user local file; a real migration
 * tool can replace it later without touching callers.
 *
 * Every activity table carries the same provenance columns — `source_system`,
 * `source_id`, `source_url`, `recorded_at`, `sync_run_id` — so a number on the
 * dashboard can be traced to the record and the run that fetched it.
 */

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_initial",
    sql: `
CREATE TABLE sync_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  status        TEXT    NOT NULL CHECK (status IN ('running','ok','failed')),
  since         TEXT    NOT NULL,
  actor_login   TEXT,
  notes         TEXT
);

CREATE TABLE repository (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT    NOT NULL UNIQUE,
  local_path        TEXT,
  provider          TEXT,
  slug              TEXT,
  default_branch    TEXT,
  default_ref       TEXT,
  head_sha          TEXT,
  head_committed_at TEXT,
  last_synced_at    TEXT
);

CREATE TABLE commit_event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id      INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  sha                TEXT    NOT NULL,
  author_name        TEXT    NOT NULL,
  author_email       TEXT    NOT NULL,
  authored_at        TEXT    NOT NULL,
  authored_at_ms     INTEGER NOT NULL,
  committer_name     TEXT    NOT NULL,
  committer_email    TEXT    NOT NULL,
  committed_at       TEXT    NOT NULL,
  committed_at_ms    INTEGER NOT NULL,
  subject            TEXT    NOT NULL,
  parent_count       INTEGER NOT NULL,
  is_merge           INTEGER NOT NULL,
  additions          INTEGER NOT NULL,
  deletions          INTEGER NOT NULL,
  files_changed      INTEGER NOT NULL,
  excluded_additions INTEGER NOT NULL,
  excluded_deletions INTEGER NOT NULL,
  excluded_files     INTEGER NOT NULL,
  binary_files       INTEGER NOT NULL,
  ref                TEXT    NOT NULL,
  source_system      TEXT    NOT NULL,
  source_id          TEXT    NOT NULL,
  source_url         TEXT,
  recorded_at        TEXT    NOT NULL,
  sync_run_id        INTEGER NOT NULL REFERENCES sync_run(id),
  UNIQUE (repository_id, sha)
);

CREATE INDEX commit_event_committed_idx ON commit_event (committed_at_ms);
CREATE INDEX commit_event_authored_idx  ON commit_event (authored_at_ms);
CREATE INDEX commit_event_author_idx    ON commit_event (author_email);

CREATE TABLE pull_request (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id    INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  number           INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('OPEN','CLOSED','MERGED')),
  is_draft         INTEGER NOT NULL,
  author_login     TEXT,
  created_at       TEXT    NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  merged_at        TEXT,
  merged_at_ms     INTEGER,
  closed_at        TEXT,
  closed_at_ms     INTEGER,
  updated_at       TEXT    NOT NULL,
  additions        INTEGER NOT NULL,
  deletions        INTEGER NOT NULL,
  changed_files    INTEGER NOT NULL,
  base_ref         TEXT,
  merge_commit_sha TEXT,
  source_system    TEXT    NOT NULL,
  source_id        TEXT    NOT NULL UNIQUE,
  source_url       TEXT,
  recorded_at      TEXT    NOT NULL,
  sync_run_id      INTEGER NOT NULL REFERENCES sync_run(id),
  UNIQUE (repository_id, number)
);

CREATE INDEX pull_request_created_idx ON pull_request (created_at_ms);
CREATE INDEX pull_request_merged_idx  ON pull_request (merged_at_ms);
CREATE INDEX pull_request_author_idx  ON pull_request (author_login);

CREATE TABLE review (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id          INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  pull_request_source_id TEXT    NOT NULL,
  pull_request_number    INTEGER NOT NULL,
  reviewer_login         TEXT    NOT NULL,
  state                  TEXT    NOT NULL,
  submitted_at           TEXT    NOT NULL,
  submitted_at_ms        INTEGER NOT NULL,
  source_system          TEXT    NOT NULL,
  source_id              TEXT    NOT NULL UNIQUE,
  source_url             TEXT,
  recorded_at            TEXT    NOT NULL,
  sync_run_id            INTEGER NOT NULL REFERENCES sync_run(id)
);

CREATE INDEX review_submitted_idx ON review (submitted_at_ms);
CREATE INDEX review_reviewer_idx  ON review (reviewer_login);
`,
  },
];
