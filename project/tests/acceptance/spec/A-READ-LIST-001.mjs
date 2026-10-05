export const id = 'A-READ-LIST-001'
export const title = '列表：空集合可遍历、顺序稳定、done 与 q 过滤可预期'

export default async function run(api) {
  const server = await api.startServer()
  const list = (query = '') => api.request(server, { method: 'GET', path: `/api/v1/todos${query}`, token: 'alice-secret' })
  try {
    const empty = await list()
    const created = []
    for (const title of ['first', 'second', 'third']) {
      created.push((await api.request(server, { method: 'POST', path: '/api/v1/todos', token: 'alice-secret', body: { title } })).body)
    }
    const all = await list()
    const allAgain = await list()
    await api.request(server, { method: 'PATCH', path: `/api/v1/todos/${created[1].id}`, token: 'alice-secret', body: { done: true } })
    const doneOnly = await list('?done=true')
    const remaining = await list('?done=false')
    const matched = await list('?q=ir')
    return { empty, all, allAgain, doneOnly, remaining, matched }
  } finally {
    await api.stopServer(server)
  }
}

const titles = (response) => ((response.body && response.body.items) || []).map((item) => item.title)

export function assertions(observed) {
  return [
    ['the empty collection answers 200 with an empty items array and a null next_cursor', observed.empty.status === 200 && Array.isArray(observed.empty.body.items) && observed.empty.body.items.length === 0 && observed.empty.body.next_cursor === null, `body=${JSON.stringify(observed.empty.body)}`],
    ['the three todos come back newest first', JSON.stringify(titles(observed.all)) === JSON.stringify(['third', 'second', 'first']), `titles=${JSON.stringify(titles(observed.all))}`],
    ['the order is stable across calls', JSON.stringify(titles(observed.allAgain)) === JSON.stringify(titles(observed.all)), `again=${JSON.stringify(titles(observed.allAgain))}`],
    ['the done filter returns only the todos whose done flag matches', JSON.stringify(titles(observed.doneOnly)) === JSON.stringify(['second']) && JSON.stringify(titles(observed.remaining)) === JSON.stringify(['third', 'first']), `done=${JSON.stringify(titles(observed.doneOnly))} notDone=${JSON.stringify(titles(observed.remaining))}`],
    ['the q filter returns only todos whose title contains the substring', JSON.stringify(titles(observed.matched)) === JSON.stringify(['third', 'first']), `matched=${JSON.stringify(titles(observed.matched))}`],
  ]
}
