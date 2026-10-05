export const id = 'A-CONCURRENCY-PUT-001'
export const title = '并发 If-Match 更新：恰好一个成功、一个 412，存储不留部分结果'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const path = '/api/v1/todos/concurrent-target'
    const base = await api.request(server, {
      method: 'PUT',
      path,
      token: 'alice-secret',
      body: { title: 'base', done: false, notes: 'base' },
    })
    const [left, right] = await Promise.all([
      api.request(server, {
        method: 'PUT',
        path,
        token: 'alice-secret',
        headers: { 'If-Match': '1' },
        body: { title: 'winner left', done: false, notes: 'left' },
      }),
      api.request(server, {
        method: 'PUT',
        path,
        token: 'alice-secret',
        headers: { 'If-Match': '1' },
        body: { title: 'winner right', done: true, notes: 'right' },
      }),
    ])
    const readBack = await api.request(server, { method: 'GET', path, token: 'alice-secret' })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { base, left, right, readBack, listed }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const statuses = [observed.left.status, observed.right.status].sort((a, b) => a - b)
  const winner = observed.left.status === 200 ? observed.left.body : observed.right.body
  const loser = observed.left.status === 200 ? observed.right : observed.left
  const readBack = observed.readBack.body || {}
  const items = (observed.listed.body && observed.listed.body.items) || []
  return [
    ['exactly one of the two requests succeeds with 200 and the other is rejected with 412', statuses[0] === 200 && statuses[1] === 412, `statuses=${JSON.stringify([observed.left.status, observed.right.status])}`],
    ['the rejected writer gets precondition_failed', loser.status === 412 && loser.body && loser.body.error && loser.body.error.code === 'precondition_failed', `loser=${JSON.stringify(loser.body)}`],
    ['the stored todo matches the winning representation', Boolean(winner) && readBack.title === winner.title && readBack.done === winner.done && readBack.notes === winner.notes, `winner=${JSON.stringify(winner)} stored=${JSON.stringify(readBack)}`],
    ['the version advanced exactly once, so no lost update happened', readBack.version === 2, `version=${readBack.version}`],
    ['no partially applied mix of the two bodies is stored', items.length === 1 && !(readBack.title === 'winner left' && readBack.done === true), `stored=${JSON.stringify(readBack)}`],
  ]
}
