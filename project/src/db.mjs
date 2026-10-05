/**
 * Database access: opening the file, and the one transaction helper the rest of
 * the code uses.
 *
 * Every write goes through `withTransaction`, which uses `BEGIN IMMEDIATE`, so a
 * read-modify-write (version check, create-or-replace, quota check) cannot
 * interleave with another writer. A rejected write rolls back completely, which
 * is what makes "no partial success" observable rather than hoped for.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class DatabaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DatabaseError'
  }
}

export function openDatabase(dbPath) {
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
  } catch (cause) {
    throw new DatabaseError(`cannot prepare database path ${dbPath}: ${cause.message}`)
  }
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (cause) {
    throw new DatabaseError(`cannot open database ${dbPath}: ${cause.message}`)
  }
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
  } catch (cause) {
    throw new DatabaseError(`cannot configure database ${dbPath}: ${cause.message}`)
  }
  return db
}

export function withTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  let result
  try {
    result = work()
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error
  }
  db.exec('COMMIT')
  return result
}
