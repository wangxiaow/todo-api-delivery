export const id = 'A-VALIDATION-BODY-001'
export const title = '非法 JSON 与超大请求体被有界拒绝，服务随后仍能正常工作'

const MAX_BODY = 4096

export default async function run(api) {
  const server = await api.startServer({ env: { TODO_MAX_BODY_BYTES: String(MAX_BODY) } })
  try {
    const malformed = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      rawBody: '{"title": "unterminated',
    })
    const oversized = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      rawBody: JSON.stringify({ title: 'big', notes: 'x'.repeat(MAX_BODY * 3) }),
    })
    const valid = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'after the failures' },
    })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { malformed, oversized, valid, listed }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const code = (r) => r && r.body && r.body.error && r.body.error.code
  const items = (observed.listed && observed.listed.body && observed.listed.body.items) || null
  return [
    ['malformed JSON is rejected with 400 and error code invalid_json', observed.malformed.status === 400 && code(observed.malformed) === 'invalid_json', `status=${observed.malformed.status} code=${code(observed.malformed)}`],
    ['a body over the declared limit is rejected with 413 and error code payload_too_large', observed.oversized.status === 413 && code(observed.oversized) === 'payload_too_large', `status=${observed.oversized.status} code=${code(observed.oversized)}`],
    ['the service still accepts a valid body afterwards', observed.valid.status === 201, `status=${observed.valid.status} body=${JSON.stringify(observed.valid.body)}`],
    ['the oversized and malformed requests persisted nothing, so exactly one todo exists', Array.isArray(items) && items.length === 1 && items[0].title === 'after the failures', `items=${JSON.stringify(items)}`],
  ]
}
