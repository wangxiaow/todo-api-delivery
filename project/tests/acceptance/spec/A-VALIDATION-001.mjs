export const id = 'A-VALIDATION-001'
export const title = '缺失必填字段与未知字段都被 400 拒绝，且不留任何持久化痕迹'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const missingTitle = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { notes: 'no title here' },
    })
    const unknownField = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'valid title', surprise: true },
    })
    const wrongType = await api.request(server, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 42 },
    })
    const listed = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    return { missingTitle, unknownField, wrongType, listed }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const code = (r) => r && r.body && r.body.error && r.body.error.code
  const items = (observed.listed && observed.listed.body && observed.listed.body.items) || null
  return [
    ['a missing required field is rejected with 400 validation_error', observed.missingTitle.status === 400 && code(observed.missingTitle) === 'validation_error', `status=${observed.missingTitle.status} code=${code(observed.missingTitle)}`],
    ['an unknown field is rejected with 400 validation_error', observed.unknownField.status === 400 && code(observed.unknownField) === 'validation_error', `status=${observed.unknownField.status} code=${code(observed.unknownField)}`],
    ['a field with the wrong type is rejected with 400 validation_error', observed.wrongType.status === 400 && code(observed.wrongType) === 'validation_error', `status=${observed.wrongType.status} code=${code(observed.wrongType)}`],
    ['a rejected request persists no todo', Array.isArray(items) && items.length === 0, `items=${JSON.stringify(items)}`],
  ]
}
