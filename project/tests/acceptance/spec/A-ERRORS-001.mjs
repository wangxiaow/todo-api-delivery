export const id = 'A-ERRORS-001'
export const title = '错误模型稳定且不泄漏凭据、SQL 或堆栈'

const PRESENTED_TOKEN = 'leak-me-please-0123456789'
const FORBIDDEN = [
  PRESENTED_TOKEN,
  'SELECT ',
  'INSERT INTO',
  'UPDATE todos',
  'DELETE FROM',
  'node:sqlite',
  '    at ',
  '.mjs:',
]

export default async function run(api) {
  const server = await api.startServer()
  try {
    const unknownPath = await api.request(server, { method: 'GET', path: '/api/v1/no-such-resource', token: 'alice-secret' })
    const wrongMethod = await api.request(server, { method: 'POST', path: '/api/v1/todos/some-id', token: 'alice-secret', body: { title: 'x' } })
    const unauthorized = await api.request(server, { method: 'GET', path: '/api/v1/todos', token: PRESENTED_TOKEN })
    const invalidBody = await api.request(server, { method: 'POST', path: '/api/v1/todos', token: 'alice-secret', body: { notes: 'no title' } })
    return {
      responses: [unknownPath, wrongMethod, unauthorized, invalidBody].map((response) => ({
        status: response.status,
        headers: response.headers,
        body: response.body,
        bodyText: String(response.bodyText || ''),
      })),
    }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const [unknownPath, wrongMethod, unauthorized, invalidBody] = observed.responses || []
  const errorOf = (r) => (r && r.body && r.body.error) || {}
  const leaked = []
  for (const response of observed.responses || []) {
    for (const needle of FORBIDDEN) {
      if (response.bodyText.includes(needle)) leaked.push(`${response.status}:${needle}`)
    }
  }
  return [
    ['an unknown path answers 404 with error code not_found', unknownPath.status === 404 && errorOf(unknownPath).code === 'not_found', `response=${JSON.stringify(unknownPath)}`],
    ['a wrong method on a known path answers 405 with error code method_not_allowed', wrongMethod.status === 405 && errorOf(wrongMethod).code === 'method_not_allowed', `response=${JSON.stringify(wrongMethod)}`],
    ['the 405 response advertises the allowed methods', String((wrongMethod.headers || {}).allow || '').includes('PATCH'), `allow=${JSON.stringify((wrongMethod.headers || {}).allow)}`],
    ['an invalid body answers 400 with error code validation_error', invalidBody.status === 400 && errorOf(invalidBody).code === 'validation_error', `response=${JSON.stringify(invalidBody)}`],
    ['an unauthorized request answers 401 with error code unauthorized', unauthorized.status === 401 && errorOf(unauthorized).code === 'unauthorized', `response=${JSON.stringify(unauthorized)}`],
    ['an error response carries a stable error code and the request id', observed.responses.every((r) => typeof errorOf(r).code === 'string' && typeof errorOf(r).request_id === 'string' && errorOf(r).request_id.length > 0), `errors=${JSON.stringify(observed.responses.map(errorOf))}`],
    ['no error response body contains a credential, a SQL statement or a stack frame', leaked.length === 0, `leaked=${JSON.stringify(leaked)}`],
  ]
}
