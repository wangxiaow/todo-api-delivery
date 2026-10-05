-- 001_init.sql
--
-- First migration. Applied by src/migrations.mjs in filename order and recorded in
-- schema_migrations, so re-running the service never repeats it.
--
-- The table is deliberately additive-only from here on: later migrations add
-- columns or tables with IF NOT EXISTS, so an older database file stays usable and
-- rolling back is a matter of deleting the file.

CREATE TABLE IF NOT EXISTS todos (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT    NOT NULL UNIQUE,
  owner_id    TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  notes       TEXT    NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK (length(title) BETWEEN 1 AND 1000),
  CHECK (done IN (0, 1)),
  CHECK (version >= 1)
);

-- The list endpoint is always scoped to one owner and ordered newest first.
CREATE INDEX IF NOT EXISTS idx_todos_owner_seq ON todos (owner_id, seq DESC);

-- Idempotency support for POST /api/v1/todos.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT    NOT NULL,
  owner_id     TEXT    NOT NULL,
  request_hash TEXT    NOT NULL,
  todo_id      TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (key, owner_id)
);
