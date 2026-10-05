export const id = 'A-PERSIST-ATOMIC-001'
export const title = '被拒绝的写入不留部分结果：存储行逐字段不变'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const created = (await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'untouched', notes: 'immutable so far' },
    })).body
    const path = `/api/v1/todos/${created.id}`
    const before = await api.request(server, { method: 'GET', path, token: 'alice-secret' })

    const rejected = []
    rejected.push(await api.request(server, { method: 'PATCH', path, token: 'alice-secret', body: { unknown_field: 'x' } }))
    rejected.push(await api.request(server, { method: 'PATCH', path, token: 'alice-secret', body: { title: 'y'.repeat(500) } }))
    rejected.push(await api.request(server, { method: 'PUT', path, token: 'alice-secret', headers: { 'If-Match': '99' }, body: { title: 'stale', done: true } }))
    rejected.push(await api.request(server, { method: 'PATCH', path, token: 'bob-secret', body: { title: 'hijack' } }))
    rejected.push(await api.request(server, { method: 'POST', path: '/api/v1/todos', token: 'alice-secret', body: { notes: 'no title' } }))

    const after = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { before, after, listed, rejected: rejected.map((r) => r.status) }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const before = observed.before.body || {}
  const after = observed.after.body || {}
  const items = (observed.listed.body && observed.listed.body.items) || []
  return [
    ['every rejected write was actually rejected', observed.rejected.every((status) => status >= 400), `statuses=${JSON.stringify(observed.rejected)}`],
    ['the stored todo keeps the same version, title, done flag, notes and updated_at', after.version === before.version && after.title === before.title && after.done === before.done && after.notes === before.notes && after.updated_at === before.updated_at, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`],
    ['the number of todos does not change after rejected creates', items.length === 1, `items=${JSON.stringify(items)}`],
    ['a read after the rejected writes returns the original representation', JSON.stringify(after) === JSON.stringify(before), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`],
  ]
}
