/**
 * Migrations: plain SQL files applied in filename order, each recorded once.
 *
 * Running the service twice against the same file applies nothing the second
 * time, and the applied count is observable through /version so "the migration
 * ran exactly once" is checkable rather than assumed.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withTransaction } from './db.mjs'

export const MIGRATION_TABLE = 'schema_migrations'
const MIGRATION_FILE = /^(\d+)_.+\.sql$/

export function ensureMigrationTable(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  )
}

export function listMigrationFiles(migrationsDir) {
  let names
  try {
    names = readdirSync(migrationsDir)
  } catch (cause) {
    throw new Error(`cannot read migrations directory ${migrationsDir}: ${cause.message}`)
  }
  return names.filter((name) => MIGRATION_FILE.test(name)).sort((a, b) => Number(a.match(MIGRATION_FILE)[1]) - Number(b.match(MIGRATION_FILE)[1]))
}

export function runMigrations(db, migrationsDir) {
  ensureMigrationTable(db)
  const files = listMigrationFiles(migrationsDir)
  if (files.length === 0) throw new Error(`no migration files found in ${migrationsDir}`)
  const appliedVersions = new Set(
    db.prepare(`SELECT version FROM ${MIGRATION_TABLE}`).all().map((row) => Number(row.version)),
  )
  let applied = 0
  for (const file of files) {
    const version = Number(file.match(MIGRATION_FILE)[1])
    if (appliedVersions.has(version)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    withTransaction(db, () => {
      db.exec(sql)
      db.prepare(`INSERT INTO ${MIGRATION_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`).run(
        version,
        file,
        new Date().toISOString(),
      )
    })
    applied += 1
  }
  return { schemaVersion: currentSchemaVersion(db), applied }
}

export function currentSchemaVersion(db) {
  ensureMigrationTable(db)
  const row = db.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM ${MIGRATION_TABLE}`).get()
  return Number(row.version)
}

export function migrationsApplied(db) {
  ensureMigrationTable(db)
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()
  return Number(row.count)
}
