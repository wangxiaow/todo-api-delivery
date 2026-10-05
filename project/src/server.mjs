/**
 * The listening HTTP server.
 *
 * `requestTimeout` bounds how long one request may occupy the process, and the
 * server never queues work of its own: when connections pile up the operating
 * system holds the backlog, so there is no unbounded retry loop inside the
 * service to turn a slow client into a stuck process.
 */

import { createServer as createHttpServer } from 'node:http'
import { createRequestHandler } from './http/app.mjs'

export function createApiServer({ config, db, logger, state }) {
  const handle = createRequestHandler({ config, db, logger, state })
  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error({ event: 'request_failed', message: String(error && error.message ? error.message : error) })
      try {
        res.destroy()
      } catch {
        // The socket is already gone; nothing left to report.
      }
    })
  })
  server.requestTimeout = config.requestTimeoutMs
  server.keepAliveTimeout = 5000
  return server
}
