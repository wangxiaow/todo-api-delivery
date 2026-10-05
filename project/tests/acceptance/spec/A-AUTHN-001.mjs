export const id = 'A-AUTHN-001'
export const title = '缺失、未知与空白凭据都被 401 拒绝，绝不降级为匿名访问'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const anonymousCreate = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: null,
      body: { title: 'anonymous attempt' },
    })
    const anonymousList = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: null })
    const unknownToken = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'not-a-real-token',
      body: { title: 'unknown token attempt' },
    })
    const emptyBearer = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: '',
      body: { title: 'empty bearer attempt' },
    })
    const authorize = (await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'legitimate todo' },
    })).body
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { anonymousCreate, anonymousList, unknownToken, emptyBearer, authorize, listed }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const code = (r) => r && r.body && r.body.error && r.body.error.code
  const status = (r) => (r ? r.status : null)
  const items = (observed.listed && observed.listed.body && observed.listed.body.items) || null
  return [
    ['missing token is rejected with 401 unauthorized', status(observed.anonymousCreate) === 401 && code(observed.anonymousCreate) === 'unauthorized', `status=${status(observed.anonymousCreate)} code=${code(observed.anonymousCreate)}`],
    ['a read without a credential is rejected with 401 unauthorized', status(observed.anonymousList) === 401 && code(observed.anonymousList) === 'unauthorized', `status=${status(observed.anonymousList)} code=${code(observed.anonymousList)}`],
    ['unknown token is rejected with 401 unauthorized', status(observed.unknownToken) === 401 && code(observed.unknownToken) === 'unauthorized', `status=${status(observed.unknownToken)} code=${code(observed.unknownToken)}`],
    ['an empty bearer credential is rejected with 401 unauthorized', status(observed.emptyBearer) === 401 && code(observed.emptyBearer) === 'unauthorized', `status=${status(observed.emptyBearer)} code=${code(observed.emptyBearer)}`],
    ['no todo is created and no todo is returned for an unauthenticated request', Array.isArray(items) && items.length === 1 && items[0].title === 'legitimate todo', `items=${JSON.stringify(items)}`],
    ['valid token can create and read todos', Boolean(observed.authorize && observed.authorize.id) && status(observed.listed) === 200, `created=${JSON.stringify(observed.authorize)}`],
  ]
}
