export const id = 'A-HEALTH-001'
export const title = '健康与就绪探针无需凭据即可判断能否接受请求'

export default async function run(api) {
  const server = await api.startServer()
  try {
    const health = await api.request(server, { method: 'GET', path: '/healthz' })
    const ready = await api.request(server, { method: 'GET', path: '/readyz' })
    const version = await api.request(server, { method: 'GET', path: '/version' })
    return { health, ready, version }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const health = observed.health || {}
  const ready = observed.ready || {}
  const version = observed.version || {}
  return [
    ['/healthz answers 200 and status ok without a credential', health.status === 200 && health.body && health.body.status === 'ok', `response=${JSON.stringify(health.body)} status=${health.status}`],
    ['/readyz answers 200 with status ready once the database is open', ready.status === 200 && ready.body && ready.body.status === 'ready', `response=${JSON.stringify(ready.body)} status=${ready.status}`],
    ['/readyz reports the schema version', ready.body && ready.body.schema_version === 1, `body=${JSON.stringify(ready.body)}`],
    ['/version answers 200 with api_version v1', version.status === 200 && version.body && version.body.api_version === 'v1', `body=${JSON.stringify(version.body)}`],
  ]
}
