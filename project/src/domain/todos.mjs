/**
 * Todo domain.
 *
 * Three invariants live here, and all three are enforced inside one IMMEDIATE
 * transaction so a rejection cannot leave a partial write behind:
 *
 *   1. ownership — a row belonging to another owner is reported exactly like a
 *      row that does not exist, and is never modified;
 *   2. versioning — If-Match is checked against the stored version before any
 *      UPDATE, so concurrent writers cannot lose each other's changes;
 *   3. idempotency — a repeated Idempotency-Key returns the first resource and
 *      never inserts a second row.
 */

import { createHash, randomUUID } from 'node:crypto'
import { withTransaction } from '../db.mjs'
import { AppError } from '../errors.mjs'

const CREATE_FIELDS = new Set(['title', 'notes', 'done'])
const PATCH_FIELDS = new Set(['title', 'notes', 'done'])
const CURSOR_PATTERN = /^\d+$/

const defaultNow = () => new Date().toISOString()

function invalid(detail) {
  throw new AppError('validation_error', 400, detail)
}

export function toApiTodo(row) {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    title: String(row.title),
    notes: String(row.notes),
    done: Number(row.done) === 1,
    version: Number(row.version),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

/* ------------------------------------------------------------- validation */

function requireObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid('body must be a JSON object')
}

function rejectUnknownFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) invalid(`unknown field: ${key}`)
  }
}

function normalizeTitle(value, maxLength) {
  if (typeof value !== 'string') invalid('title must be a string')
  const trimmed = value.trim()
  if (trimmed.length === 0) invalid('title must not be empty')
  if (trimmed.length > maxLength) invalid(`title must be at most ${maxLength} characters`)
  return trimmed
}

function normalizeNotes(value, maxLength) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') invalid('notes must be a string')
  if (value.length > maxLength) invalid(`notes must be at most ${maxLength} characters`)
  return value
}

function normalizeDone(value) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') invalid('done must be a boolean')
  return value
}

export function validateCreateInput(body, limits) {
  requireObject(body)
  rejectUnknownFields(body, CREATE_FIELDS)
  return {
    title: normalizeTitle(body.title, limits.maxTitleLength),
    notes: normalizeNotes(body.notes, limits.maxNotesLength),
    done: normalizeDone(body.done),
  }
}

export const validateReplaceInput = validateCreateInput

export function validatePatchInput(body, limits) {
  requireObject(body)
  rejectUnknownFields(body, PATCH_FIELDS)
  if (Object.keys(body).length === 0) invalid('at least one field must be provided')
  const patch = {}
  if (Object.prototype.hasOwnProperty.call(body, 'title')) patch.title = normalizeTitle(body.title, limits.maxTitleLength)
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) patch.notes = normalizeNotes(body.notes, limits.maxNotesLength)
  if (Object.prototype.hasOwnProperty.call(body, 'done')) patch.done = normalizeDone(body.done)
  return patch
}

export function parseIfMatch(header) {
  if (header === undefined || header === null) return null
  const raw = Array.isArray(header) ? header[0] : header
  const text = String(raw).trim()
  if (text === '') return null
  if (text === '*') return '*'
  const match = /^"?(\d+)"?$/.exec(text)
  if (!match) invalid('If-Match must be a version number or *')
  const version = Number(match[1])
  if (!Number.isSafeInteger(version) || version < 1) invalid('If-Match must be a positive version number')
  return version
}

function assertPrecondition(row, expected) {
  if (expected === null || expected === '*') return
  if (Number(row.version) !== expected) throw new AppError('precondition_failed', 412)
}

export function hashPayload(input) {
  return createHash('sha256')
    .update(JSON.stringify({ title: input.title, notes: input.notes, done: Boolean(input.done) }))
    .digest('hex')
}

/* -------------------------------------------------------------- accessors */

function getRow(db, id) {
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id)
  return row || null
}

function countOwned(db, ownerId) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM todos WHERE owner_id = ?').get(ownerId).count)
}

/* -------------------------------------------------------------- operations */

export function createTodo(db, { ownerId, input, idempotencyKey = null, limits, now = defaultNow }) {
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
    invalid('Idempotency-Key must be 1..128 characters')
  }
  return withTransaction(db, () => {
    const hash = hashPayload(input)
    if (idempotencyKey !== null) {
      const existing = db
        .prepare('SELECT request_hash, todo_id FROM idempotency_keys WHERE key = ? AND owner_id = ?')
        .get(idempotencyKey, ownerId)
      if (existing) {
        if (String(existing.request_hash) !== hash) throw new AppError('idempotency_key_reuse', 409)
        const row = getRow(db, existing.todo_id)
        if (row) return { todo: toApiTodo(row), created: false, replayed: true }
        // The previously created resource is gone, so this key is free again.
        db.prepare('DELETE FROM idempotency_keys WHERE key = ? AND owner_id = ?').run(idempotencyKey, ownerId)
      }
    }
    if (countOwned(db, ownerId) >= limits.maxTodosPerOwner) throw new AppError('quota_exceeded', 429)
    const id = randomUUID()
    const timestamp = now()
    db.prepare(
      'INSERT INTO todos (id, owner_id, title, notes, done, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, ownerId, input.title, input.notes, input.done ? 1 : 0, 1, timestamp, timestamp)
    if (idempotencyKey !== null) {
      db.prepare(
        'INSERT INTO idempotency_keys (key, owner_id, request_hash, todo_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(idempotencyKey, ownerId, hash, id, timestamp)
    }
    return { todo: toApiTodo(getRow(db, id)), created: true, replayed: false }
  })
}

export function readTodo(db, { id, ownerId }) {
  const row = getRow(db, id)
  if (!row || String(row.owner_id) !== ownerId) throw new AppError('not_found', 404)
  return toApiTodo(row)
}

function parseLimit(raw, limits) {
  if (raw === null || raw === undefined || raw === '') return limits.defaultLimit
  if (!CURSOR_PATTERN.test(raw)) invalid('limit must be a positive integer')
  const value = Number(raw)
  if (value < 1 || value > limits.maxLimit) invalid(`limit must be between 1 and ${limits.maxLimit}`)
  return value
}

function parseDone(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  invalid('done must be true or false')
}

function parseQueryText(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw.length > 200) invalid('q must be at most 200 characters')
  return raw
}

function parseCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  let decoded = ''
  try {
    decoded = Buffer.from(String(raw), 'base64url').toString('utf8')
  } catch {
    throw new AppError('invalid_cursor', 400)
  }
  if (!CURSOR_PATTERN.test(decoded) || Number(decoded) < 1) throw new AppError('invalid_cursor', 400)
  return Number(decoded)
}

export function listTodos(db, { ownerId, query, limits }) {
  const limit = parseLimit(query.get('limit'), limits)
  const done = parseDone(query.get('done'))
  const text = parseQueryText(query.get('q'))
  const cursor = parseCursor(query.get('cursor'))

  const where = ['owner_id = ?']
  const params = [ownerId]
  if (done !== null) {
    where.push('done = ?')
    params.push(done ? 1 : 0)
  }
  if (text !== null) {
    where.push('instr(title, ?) > 0')
    params.push(text)
  }
  if (cursor !== null) {
    where.push('seq < ?')
    params.push(cursor)
  }
  const rows = db
    .prepare(`SELECT * FROM todos WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
    .all(...params, limit + 1)
  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0
    ? Buffer.from(String(page[page.length - 1].seq), 'utf8').toString('base64url')
    : null
  return { items: page.map(toApiTodo), next_cursor: nextCursor }
}

export function replaceTodo(db, { id, ownerId, input, ifMatch = null, limits, now = defaultNow }) {
  return withTransaction(db, () => {
    const row = getRow(db, id)
    if (!row) {
      if (countOwned(db, ownerId) >= limits.maxTodosPerOwner) throw new AppError('quota_exceeded', 429)
      const timestamp = now()
      db.prepare(
        'INSERT INTO todos (id, owner_id, title, notes, done, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, ownerId, input.title, input.notes, input.done ? 1 : 0, 1, timestamp, timestamp)
      return { todo: toApiTodo(getRow(db, id)), created: true }
    }
    if (String(row.owner_id) !== ownerId) throw new AppError('not_found', 404)
    assertPrecondition(row, ifMatch)
    db.prepare('UPDATE todos SET title = ?, notes = ?, done = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
      input.title,
      input.notes,
      input.done ? 1 : 0,
      now(),
      id,
    )
    return { todo: toApiTodo(getRow(db, id)), created: false }
  })
}

export function patchTodo(db, { id, ownerId, patch, ifMatch = null, now = defaultNow }) {
  return withTransaction(db, () => {
    const row = getRow(db, id)
    if (!row || String(row.owner_id) !== ownerId) throw new AppError('not_found', 404)
    assertPrecondition(row, ifMatch)
    const next = {
      title: Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title : String(row.title),
      notes: Object.prototype.hasOwnProperty.call(patch, 'notes') ? patch.notes : String(row.notes),
      done: Object.prototype.hasOwnProperty.call(patch, 'done') ? patch.done : Number(row.done) === 1,
    }
    db.prepare('UPDATE todos SET title = ?, notes = ?, done = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
      next.title,
      next.notes,
      next.done ? 1 : 0,
      now(),
      id,
    )
    return toApiTodo(getRow(db, id))
  })
}

export function deleteTodo(db, { id, ownerId }) {
  return withTransaction(db, () => {
    const row = getRow(db, id)
    if (!row || String(row.owner_id) !== ownerId) throw new AppError('not_found', 404)
    db.prepare('DELETE FROM idempotency_keys WHERE todo_id = ?').run(id)
    db.prepare('DELETE FROM todos WHERE id = ?').run(id)
    return { id: String(id) }
  })
}
