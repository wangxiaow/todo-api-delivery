export const id = 'A-IDEMPOTENCY-DELETE-001'
export const title = 'DELETE 幂等：首次 204，重复请求 404，且不会复活数据'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const created = (await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'temporary' },
    })).body
    const path = `/api/v1/todos/${created.id}`
    const first = await api.request(server, { method: 'DELETE', path, token: 'alice-secret' })
    const second = await api.request(server, { method: 'DELETE', path, token: 'alice-secret' })
    const readBack = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { created, first, second, readBack, listed }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const items = (observed.listed && observed.listed.body && observed.listed.body.items) || null
  return [
    ['the first DELETE answers 204 with no body', observed.first.status === 204 && String(observed.first.bodyText || '') === '', `status=${observed.first.status} body=${JSON.stringify(observed.first.bodyText)}`],
    ['the second DELETE answers 404 with error code not_found', observed.second.status === 404 && observed.second.body && observed.second.body.error && observed.second.body.error.code === 'not_found', `status=${observed.second.status} body=${JSON.stringify(observed.second.body)}`],
    ['GET returns 404 after the delete', observed.readBack.status === 404, `status=${observed.readBack.status}`],
    ['the collection no longer contains the todo', Array.isArray(items) && items.length === 0, `items=${JSON.stringify(items)}`],
  ]
}
