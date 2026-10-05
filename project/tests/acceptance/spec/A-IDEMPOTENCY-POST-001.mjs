export const id = 'A-IDEMPOTENCY-POST-001'
export const title = '同一 Idempotency-Key 重复提交只产生一个 Todo；换 body 复用该 key 被 409 拒绝'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const first = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      headers: { 'Idempotency-Key': 'retry-safe-1' },
      body: { title: 'pay the invoice' },
    })
    const replay = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      headers: { 'Idempotency-Key': 'retry-safe-1' },
      body: { title: 'pay the invoice' },
    })
    const reuse = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      headers: { 'Idempotency-Key': 'retry-safe-1' },
      body: { title: 'pay a different invoice' },
    })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { first, replay, reuse, listed }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const items = (observed.listed && observed.listed.body && observed.listed.body.items) || null
  const firstId = observed.first.body && observed.first.body.id
  const replayId = observed.replay.body && observed.replay.body.id
  return [
    ['the first submission is accepted with 201', observed.first.status === 201, `status=${observed.first.status}`],
    ['a repeated idempotency key returns the first todo instead of creating a second', observed.replay.status === 200 && replayId === firstId, `status=${observed.replay.status} first=${firstId} replay=${replayId}`],
    ['the same idempotency key with a different body is rejected with 409 idempotency_key_reuse', observed.reuse.status === 409 && observed.reuse.body && observed.reuse.body.error && observed.reuse.body.error.code === 'idempotency_key_reuse', `status=${observed.reuse.status} body=${JSON.stringify(observed.reuse.body)}`],
    ['a repeated submission stores no second todo', Array.isArray(items) && items.length === 1 && items[0].title === 'pay the invoice', `items=${JSON.stringify(items)}`],
  ]
}
