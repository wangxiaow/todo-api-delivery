export const id = 'A-DEPENDENCY-RECOVERY-001'
export const title = '有界失败与恢复：超大请求被拒绝后服务仍可用，重复失败不产生副作用'

const MAX_BODY = 4096
const OVERSIZED = JSON.stringify({ title: 'too big', notes: 'x'.repeat(MAX_BODY * 2) })

export default async function run(api) {
  const server = await api.startServer({ env: { TODO_MAX_BODY_BYTES: String(MAX_BODY) } })
  try {
    const firstRejection = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      rawBody: OVERSIZED,
    })
    const valid = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'the only todo' },
    })
    const repeats = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      repeats.push(
        await api.request(server, {
          method: 'POST',
          path: '/api/v1/todos',
          token: 'alice-secret',
          rawBody: OVERSIZED,
        }),
      )
    }
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return {
      firstRejection,
      valid,
      repeats: repeats.map((r) => ({ status: r.status, code: r.body && r.body.error && r.body.error.code })),
      listed,
    }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const items = (observed.listed.body && observed.listed.body.items) || []
  const firstCode = observed.firstRejection.body && observed.firstRejection.body.error && observed.firstRejection.body.error.code
  return [
    ['the oversized body is rejected with 413 and error code payload_too_large', observed.firstRejection.status === 413 && firstCode === 'payload_too_large', `status=${observed.firstRejection.status} code=${firstCode}`],
    ['the following valid create succeeds on the same connection pool', observed.valid.status === 201, `status=${observed.valid.status}`],
    ['every repeated failure is still a bounded 413, not a retry or a hang', observed.repeats.every((r) => r.status === 413 && r.code === 'payload_too_large'), `repeats=${JSON.stringify(observed.repeats)}`],
    ['repeating the failing request never creates a todo and never duplicates one', items.length === 1 && items[0].title === 'the only todo', `items=${JSON.stringify(items)}`],
  ]
}
