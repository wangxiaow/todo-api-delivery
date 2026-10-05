/**
 * Stable error model.
 *
 * Every failure the HTTP surface reports is one of these codes with a fixed
 * status. The message is a constant for the code, never an interpolated
 * exception text, so a response body cannot leak a credential, a SQL statement
 * or a stack frame.
 */

export const ERROR_STATUS = {
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  validation_error: 400,
  invalid_json: 400,
  invalid_cursor: 400,
  payload_too_large: 413,
  idempotency_key_reuse: 409,
  precondition_failed: 412,
  quota_exceeded: 429,
  not_ready: 503,
  internal_error: 500,
}

const ERROR_MESSAGES = {
  unauthorized: 'missing or invalid credentials',
  not_found: 'the requested resource does not exist',
  method_not_allowed: 'the method is not allowed for this resource',
  validation_error: 'the request payload is not valid',
  invalid_json: 'the request body is not valid JSON',
  invalid_cursor: 'the pagination cursor is not valid',
  payload_too_large: 'the request body exceeds the configured limit',
  idempotency_key_reuse: 'the idempotency key was already used with a different payload',
  precondition_failed: 'the version precondition failed',
  quota_exceeded: 'the per-owner limit was reached',
  not_ready: 'the service is not ready',
  internal_error: 'the request could not be completed',
}

/** An error whose code and status are part of the API contract. */
export class AppError extends Error {
  constructor(code, status = null, detail = null) {
    super(ERROR_MESSAGES[code] || 'request failed')
    this.name = 'AppError'
    this.code = ERROR_MESSAGES[code] ? code : 'internal_error'
    this.status = status || ERROR_STATUS[this.code] || 500
    this.detail = detail
  }
}

export function isAppError(value) {
  return value instanceof AppError
}

/**
 * The one error shape this API returns. `detail` is deliberately not part of it:
 * internal details go to the log, never to the client.
 */
export function errorBody(code, requestId) {
  const key = ERROR_STATUS[code] ? code : 'internal_error'
  return { error: { code: key, message: ERROR_MESSAGES[key], request_id: requestId } }
}

/** Convenience for the domain layer: fail with a stable code. */
export function fail(code, detail = null) {
  throw new AppError(code, null, detail)
}
