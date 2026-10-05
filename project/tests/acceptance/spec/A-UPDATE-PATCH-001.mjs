export const id = 'A-UPDATE-PATCH-001'
export const title = 'PATCH 局部修改：只改提交的字段、版本自增，空 body 被拒绝'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const created = (await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'keep my title', notes: 'before' },
    })).body
    const path = `/api/v1/todos/${created.id}`
    const patched = await api.request(server, { method: 'PATCH', path, token: 'alice-secret', body: { done: true, notes: 'after' } })
    const readBack = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
    const empty = await api.request(server, { method: 'PATCH', path, token: 'alice-secret', body: {} })
    const afterEmpty = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
    return { created, patched, readBack, empty, afterEmpty }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const patched = observed.patched.body || {}
  const readBack = observed.readBack.body || {}
  const afterEmpty = observed.afterEmpty.body || {}
  return [
    ['the PATCH answers 200 and raises the version while keeping title and id', observed.patched.status === 200 && patched.version === 2 && patched.title === observed.created.title && patched.id === observed.created.id, `patched=${JSON.stringify(patched)}`],
    ['the stored todo reflects done and notes after the call', readBack.done === true && readBack.notes === 'after' && readBack.title === 'keep my title', `readBack=${JSON.stringify(readBack)}`],
    ['an empty PATCH body is rejected with 400 and error code validation_error', observed.empty.status === 400 && observed.empty.body && observed.empty.body.error && observed.empty.body.error.code === 'validation_error', `status=${observed.empty.status} body=${JSON.stringify(observed.empty.body)}`],
    ['the rejected empty PATCH changed nothing', afterEmpty.version === 2 && afterEmpty.done === true && afterEmpty.notes === 'after', `afterEmpty=${JSON.stringify(afterEmpty)}`],
  ]
}
