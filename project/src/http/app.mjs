/**
 * HTTP surface.
 *
 * The order of steps is deliberate: read the whole (bounded) body, then route,
 * then authenticate, then run the operation. Answering a request whose body has
 * not been consumed makes the peer see a connection reset instead of the honest
 * status, and routing before authenticating would let an unauthenticated caller
 * probe which paths exist.
 */

import { randomUUID } from 'node:crypto'
import { AppError, errorBody } from '../errors.mjs'
import { ownerFor } from '../auth.mjs'
import { readBody } from './body.mjs'
import { createRouter } from './router.mjs'
import {
  createTodo,
  deleteTodo,
  listTodos,
  parseIfMatch,
  patchTodo,
  readTodo,
  replaceTodo,
  validateCreateInput,
  validatePatchInput,
  validateReplaceInput,
} from '../domain/todos.mjs'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const API_VERSION = 'v1'

function resolveRequestId(header) {
  const raw = Array.isArray(header) ? header[0] : header
  return typeof raw === 'string' && REQUEST_ID_PATTERN.test(raw.trim()) ? raw.trim() : randomUUID()
}

function parseJsonBody(buffer) {
  const text = buffer.toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new AppError('invalid_json', 400)
  }
}

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(text)
}

export function createRequestHandler({ config, db, logger, state }) {
  const limits = {
    maxTitleLength: config.maxTitleLength,
    maxNotesLength: config.maxNotesLength,
    maxLimit: config.maxLimit,
    defaultLimit: config.defaultLimit,
    maxTodosPerOwner: config.maxTodosPerOwner,
  }

  const routes = [
    {
      method: 'GET',
      pattern: '/healthz',
      auth: false,
      handle: () => ({ status: 200, body: { status: 'ok', revision: config.buildRevision || null } }),
    },
    {
      method: 'GET',
      pattern: '/readyz',
      auth: false,
      handle: () =>
        state.ready
          ? { status: 200, body: { status: 'ready', schema_version: state.schemaVersion } }
          : { status: 503, body: errorBody('not_ready', state.lastRequestId || 'unknown') },
    },
    {
      method: 'GET',
      pattern: '/version',
      auth: false,
      handle: () => ({
        status: 200,
        body: {
          revision: config.buildRevision || 'unversioned',
          api_version: API_VERSION,
          schema_version: state.schemaVersion,
          migrations_applied: state.migrationsApplied,
          environment: config.environment,
          outbound_dependencies: [],
        },
      }),
    },
    {
      method: 'GET',
      pattern: '/api/v1/todos',
      auth: true,
      handle: ({ ownerId, url }) => ({ status: 200, body: listTodos(db, { ownerId, query: url.searchParams, limits }) }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/todos',
      auth: true,
      handle: ({ ownerId, body, req }) => {
        const input = validateCreateInput(body, limits)
        const header = req.headers['idempotency-key']
        const idempotencyKey = Array.isArray(header) ? header[0] : header
        const result = createTodo(db, { ownerId, input, idempotencyKey: idempotencyKey ?? null, limits })
        return {
          status: result.replayed ? 200 : 201,
          body: result.todo,
          headers: { Location: `/api/v1/todos/${result.todo.id}` },
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/todos/:id',
      auth: true,
      handle: ({ ownerId, params }) => ({ status: 200, body: readTodo(db, { id: params.id, ownerId }) }),
    },
    {
      method: 'PUT',
      pattern: '/api/v1/todos/:id',
      auth: true,
      handle: ({ ownerId, params, body, req }) => {
        const input = validateReplaceInput(body, limits)
        const result = replaceTodo(db, {
          id: params.id,
          ownerId,
          input,
          ifMatch: parseIfMatch(req.headers['if-match']),
          limits,
        })
        return { status: result.created ? 201 : 200, body: result.todo, headers: { Location: `/api/v1/todos/${result.todo.id}` } }
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/v1/todos/:id',
      auth: true,
      handle: ({ ownerId, params, body, req }) => {
        const patch = validatePatchInput(body, limits)
        const todo = patchTodo(db, { id: params.id, ownerId, patch, ifMatch: parseIfMatch(req.headers['if-match']) })
        return { status: 200, body: todo }
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/todos/:id',
      auth: true,
      handle: ({ ownerId, params }) => {
        deleteTodo(db, { id: params.id, ownerId })
        return { status: 204, empty: true }
      },
    },
  ]

  const route = createRouter(routes)

  return async function handle(req, res) {
    const started = Date.now()
    const requestId = resolveRequestId(req.headers['x-request-id'])
    state.lastRequestId = requestId
    res.setHeader('X-Request-Id', requestId)
    let pathname = '/'
    let ownerId = null
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      pathname = url.pathname
      const body = await readBody(req, config.maxBodyBytes)
      if (body.tooLarge) throw new AppError('payload_too_large', 413)
      const matched = route(req.method, pathname)
      if (!matched) throw new AppError('not_found', 404)
      if (matched.methodNotAllowed) {
        res.setHeader('Allow', matched.methodNotAllowed.join(', '))
        throw new AppError('method_not_allowed', 405)
      }
      if (matched.route.auth) {
        ownerId = ownerFor(config.tokens, req.headers.authorization)
      }
      const result = matched.route.handle({
        req,
        url,
        params: matched.params || {},
        ownerId,
        body: parseJsonBody(body.buffer),
      })
      if (result.empty === true) {
        res.writeHead(result.status, { 'Cache-Control': 'no-store', ...(result.headers || {}) })
        res.end()
        return
      }
      sendJson(res, result.status, result.body, result.headers || {})
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('internal_error', 500)
      if (!(error instanceof AppError)) {
        logger.error({
          event: 'unhandled_error',
          request_id: requestId,
          method: req.method,
          path: pathname,
          message: String(error && error.message ? error.message : error),
          stack: String(error && error.stack ? error.stack : ''),
        })
      }
      sendJson(res, appError.status, errorBody(appError.code, requestId))
    } finally {
      logger.info({
        event: 'request',
        request_id: requestId,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        duration_ms: Date.now() - started,
        owner_id: ownerId,
      })
    }
  }
}
