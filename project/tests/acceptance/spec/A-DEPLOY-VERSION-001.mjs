export const id = 'A-DEPLOY-VERSION-001'
export const title = '运行中的服务报告注入的构建版本与声明的环境，且不需要外部依赖'

const REVISION = 'acceptance-build-42'

export default async function run(api) {
  const server = await api.startServer({
    env: { TODO_BUILD_REVISION: REVISION, TODO_ENVIRONMENT: 'production_like_ci' },
  })
  try {
    const version = await api.request(server, { method: 'GET', path: '/version' })
    return { version, baseUrl: server.baseUrl }
  } finally {
    await api.stopServer(server)
  }
}

export function assertions(observed) {
  const version = observed.version || {}
  const body = version.body || {}
  const dependencies = body.outbound_dependencies
  return [
    ['/version reports exactly the injected build revision', version.status === 200 && body.revision === REVISION, `body=${JSON.stringify(body)}`],
    ['/version reports the api version and the schema version', body.api_version === 'v1' && body.schema_version === 1, `body=${JSON.stringify(body)}`],
    ['/version reports the declared environment', body.environment === 'production_like_ci', `body=${JSON.stringify(body)}`],
    ['the service is reachable over the loopback socket only', /^http:\/\/127\.0\.0\.1:\d+$/.test(String(observed.baseUrl || '')), `baseUrl=${observed.baseUrl}`],
    ['the service declares no outbound dependency', Array.isArray(dependencies) && dependencies.length === 0, `outbound_dependencies=${JSON.stringify(dependencies)}`],
  ]
}
