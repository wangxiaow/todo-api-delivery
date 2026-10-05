export const id = 'A-READ-NOT-FOUND-001'
export const title = '未知 id 返回稳定的 404 信封，且不泄漏实现细节'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const response = await api.request(server, {
      method: 'GET',
      path: '/api/v1/todos/00000000-0000-4000-8000-000000000000',
      token: 'alice-secret',
    })
    return { response }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const response = observed.response || {}
  const error = (response.body && response.body.error) || {}
  const text = String(response.bodyText || '')
  return [
    ['the response is 404 with error code not_found', response.status === 404 && error.code === 'not_found', `status=${response.status} body=${JSON.stringify(response.body)}`],
    ['the error body carries the request id', typeof error.request_id === 'string' && error.request_id.length > 0, `error=${JSON.stringify(error)}`],
    ['the error body carries no stack frame', !text.includes('    at ') && !text.includes('node:sqlite'), `body=${text.slice(0, 200)}`],
  ]
}
