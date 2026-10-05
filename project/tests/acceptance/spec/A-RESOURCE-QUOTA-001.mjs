export const id = 'A-RESOURCE-QUOTA-001'
export const title = '每位所有者的数量上限被声明并以 429 拒绝，且不影响其他所有者'

export default async function run(api) {
  const server = await api.startServer({ env: { TODO_MAX_TODOS_PER_OWNER: '2' } })
  try {
    const alice = []
    for (const title of ['alice one', 'alice two', 'alice three']) {
      alice.push(await api.request(server, { method: 'POST', path: '/api/v1/todos', token: 'alice-secret', body: { title } }))
    }
    const aliceList = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    const bobCreate = await api.request(server, { method: 'POST', path: '/api/v1/todos', token: 'bob-secret', body: { title: 'bob one' } })
    const bobList = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'bob-secret' })
    return { alice: alice.map((r) => r.status), quotaBody: alice[2].body, aliceList, bobCreate, bobList }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const aliceItems = (observed.aliceList.body && observed.aliceList.body.items) || []
  const bobItems = (observed.bobList.body && observed.bobList.body.items) || []
  const code = observed.quotaBody && observed.quotaBody.error && observed.quotaBody.error.code
  return [
    ['the first two creates are accepted', observed.alice[0] === 201 && observed.alice[1] === 201, `statuses=${JSON.stringify(observed.alice)}`],
    ["alice's third create is rejected with 429 and error code quota_exceeded", observed.alice[2] === 429 && code === 'quota_exceeded', `status=${observed.alice[2]} code=${code}`],
    ['alice still has exactly two todos', aliceItems.length === 2, `items=${JSON.stringify(aliceItems.map((i) => i.title))}`],
    ["bob's create succeeds because the cap is per owner", observed.bobCreate.status === 201 && bobItems.length === 1, `status=${observed.bobCreate.status} items=${JSON.stringify(bobItems.map((i) => i.title))}`],
  ]
}
