export const id = 'A-IDEMPOTENCY-PUT-001'
export const title = 'PUT 是 create-or-replace：重复提交收敛到同一表示，陈旧 If-Match 被 412 拒绝'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const path = '/api/v1/todos/client-chosen-id'
    const first = await api.request(server, {
      method: 'PUT',
      path,
      token: 'alice-secret',
      body: { title: 'replace me', done: false, notes: 'v1' },
    })
    const second = await api.request(server, {
      method: 'PUT',
      path,
      token: 'alice-secret',
      body: { title: 'replace me', done: false, notes: 'v1' },
    })
    const stale = await api.request(server, {
      method: 'PUT',
      path,
      token: 'alice-secret',
      headers: { 'If-Match': '1' },
      body: { title: 'stale writer', done: true },
    })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    const readBack = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
    return { first, second, stale, listed, readBack }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const items = (observed.listed && observed.listed.body && observed.listed.body.items) || null
  const readBack = observed.readBack && observed.readBack.body
  return [
    ['the first PUT creates the todo with 201 and the second replaces it with 200', observed.first.status === 201 && observed.second.status === 200, `first=${observed.first.status} second=${observed.second.status}`],
    ['both PUTs address the same client-chosen id', observed.first.body && observed.first.body.id === 'client-chosen-id' && observed.second.body && observed.second.body.id === 'client-chosen-id', `first=${JSON.stringify(observed.first.body)}`],
    ['the collection contains exactly one todo with the submitted title and done flag', Array.isArray(items) && items.length === 1 && items[0].title === 'replace me' && items[0].done === false, `items=${JSON.stringify(items)}`],
    ['a PUT carrying a stale If-Match version is rejected with 412 and changes nothing', observed.stale.status === 412 && observed.stale.body && observed.stale.body.error && observed.stale.body.error.code === 'precondition_failed', `status=${observed.stale.status} body=${JSON.stringify(observed.stale.body)}`],
    ['the stored representation survived the rejected PUT unchanged', Boolean(readBack) && readBack.title === 'replace me' && readBack.done === false && readBack.notes === 'v1' && readBack.version === 2, `readBack=${JSON.stringify(readBack)}`],
  ]
}
