export const id = 'A-OBSERVABILITY-001'
export const title = '请求关联：客户端请求 id 被回显并进入错误信封与结构化日志'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const traced = await api.request(server, {
      method: 'GET',
      path: '/api/v1/no-such-resource',
      token: 'alice-secret',
      headers: { 'X-Request-Id': 'req-trace-42' },
    })
    const generated = await api.request(server, { method: 'GET', path: '/healthz' })
    const tracedLog = await api.waitForLog(server, (line) => line.request_id === 'req-trace-42')
    return { traced, generated, tracedLog, logCount: server.logs().length }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const traced = observed.traced || {}
  const generated = observed.generated || {}
  const error = (traced.body && traced.body.error) || {}
  const header = (traced.headers || {})['x-request-id']
  const generatedHeader = (generated.headers || {})['x-request-id']
  const log = observed.tracedLog || {}
  return [
    ['a valid client request id is echoed in the response header', header === 'req-trace-42', `header=${header}`],
    ['a valid client request id is echoed in the error envelope', error.request_id === 'req-trace-42', `error=${JSON.stringify(error)}`],
    ['a request without one still receives a generated request id', typeof generatedHeader === 'string' && generatedHeader.length >= 8 && generatedHeader !== 'req-trace-42', `header=${generatedHeader}`],
    ['one structured log line for the request names the request id', log.request_id === 'req-trace-42', `log=${JSON.stringify(log)}`],
    ['that log line also names the method, the path and the status', log.method === 'GET' && log.path === '/api/v1/no-such-resource' && log.status === 404, `log=${JSON.stringify(log)}`],
  ]
}
