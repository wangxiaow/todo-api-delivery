export const id = 'A-CREATE-001'
export const title = '创建一个 Todo 返回 201，并能立即按 Location 读回同一个 Todo'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const created = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      headers: { 'Idempotency-Key': 'create-once' },
      body: { title: 'buy milk', notes: 'two litres' },
    })
    const location = created.headers.location || null
    const fetched = location
      ? await api.request(server, { method: 'GET', path: location, token: 'alice-secret' })
      : null
    return { created, location, fetched }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const created = observed.created || {}
  const body = created.body || {}
  const fetched = observed.fetched || {}
  const fetchedBody = fetched.body || {}
  return [
    ['a well-formed request body is accepted with 201', created.status === 201, `status=${created.status}`],
    [
      'the response carries a Location header pointing at the created todo',
      typeof body.id === 'string' && body.id.length > 0 && observed.location === `/api/v1/todos/${body.id}`,
      `location=${observed.location} id=${body.id}`,
    ],
    [
      'the created representation carries owner, title, done and version',
      body.owner_id === 'alice' && body.title === 'buy milk' && body.done === false && body.version === 1,
      `body=${JSON.stringify(body)}`,
    ],
    ['GET on that location returns the same id and title', fetched.status === 200 && fetchedBody.id === body.id && fetchedBody.title === 'buy milk', `status=${fetched.status} body=${JSON.stringify(fetchedBody)}`],
  ]
}
