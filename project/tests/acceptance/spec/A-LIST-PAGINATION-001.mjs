export const id = 'A-LIST-PAGINATION-001'
export const title = '分页游标可遍历且不重不漏；limit 与 cursor 的边界有明确错误'

export default async function run(api) {
  const server = await api.startServer()
  const get = (query) => api.request(server, { method: 'GET', path: `/api/v1/todos${query}`, token: 'alice-secret' })
  try {
    const createdIds = []
    for (let index = 1; index <= 5; index += 1) {
      const body = (await api.request(server, {
        method: 'POST',
        path: '/api/v1/todos',
        token: 'alice-secret',
        body: { title: `page item ${index}` },
      })).body
      createdIds.push(body.id)
    }

    const pages = []
    const seen = []
    let cursor = null
    for (let step = 0; step < 10; step += 1) {
      const response = await get(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      pages.push({ status: response.status, count: ((response.body && response.body.items) || []).length })
      for (const item of (response.body && response.body.items) || []) seen.push(item.id)
      cursor = response.body && response.body.next_cursor
      if (!cursor) break
    }

    const zero = await get('?limit=0')
    const tooLarge = await get('?limit=101')
    const badCursor = await get('?cursor=not-a-real-cursor')
    return { createdIds, seen, pages, zero, tooLarge, badCursor }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const code = (r) => r && r.body && r.body.error && r.body.error.code
  const unique = new Set(observed.seen)
  return [
    ['walking every page yields each todo exactly once', observed.seen.length === 5 && unique.size === 5 && observed.createdIds.every((id) => unique.has(id)), `seen=${JSON.stringify(observed.seen)}`],
    ['every page respects the requested limit and the walk ends with a null cursor', observed.pages.every((page) => page.status === 200 && page.count <= 2) && observed.pages.at(-1).count === 1, `pages=${JSON.stringify(observed.pages)}`],
    ['limit=0 is rejected with 400 and error code validation_error', observed.zero.status === 400 && code(observed.zero) === 'validation_error', `status=${observed.zero.status} code=${code(observed.zero)}`],
    ['limit above the declared maximum is rejected with 400 and error code validation_error', observed.tooLarge.status === 400 && code(observed.tooLarge) === 'validation_error', `status=${observed.tooLarge.status} code=${code(observed.tooLarge)}`],
    ['an unknown cursor is rejected with 400 and error code invalid_cursor', observed.badCursor.status === 400 && code(observed.badCursor) === 'invalid_cursor', `status=${observed.badCursor.status} code=${code(observed.badCursor)}`],
  ]
}
