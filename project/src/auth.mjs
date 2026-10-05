/**
 * Authentication: the credential map from configuration is the whole policy.
 *
 * A request without a usable `Authorization: Bearer <token>` header is rejected
 * before any domain work happens. There is no anonymous path and no fallback
 * owner, so "missing credential" cannot degrade into broader access.
 */

import { timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.mjs'

function equalInConstantTime(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  if (a.length !== b.length) {
    // Still compare something of equal length so the failure path costs the same.
    timingSafeEqual(a, Buffer.alloc(a.length))
    return false
  }
  return timingSafeEqual(a, b)
}

export function ownerFor(tokens, authorizationHeader) {
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader
  const presented = typeof header === 'string' ? /^Bearer[ ]+(\S+)$/.exec(header.trim()) : null
  if (!presented) throw new AppError('unauthorized', 401)
  const value = presented[1]
  let owner = null
  // Every configured credential is compared, so the number of comparisons does
  // not reveal which token (if any) matched.
  for (const [token, name] of tokens) {
    if (equalInConstantTime(token, value)) owner = name
  }
  if (owner === null) throw new AppError('unauthorized', 401)
  return owner
}
