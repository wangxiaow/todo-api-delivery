export const id = 'A-STARTUP-FAILFAST-001'
export const title = '数据库无法准备时启动失败并明确退出，不会带着坏状态监听端口'

export default async function run(api) {
  // A real file whose path is then used as a *directory*, so preparing the
  // database path cannot succeed on any platform.
  const blocker = api.newTmpFile()
  const dbPath = `${blocker}/nested/todos.db`
  const port = await api.freePort()
  const run = await api.runCli({
    args: ['serve'],
    env: {
      TODO_DB_PATH: dbPath,
      TODO_PORT: String(port),
      TODO_API_TOKENS: 'alice:alice-secret',
    },
    timeoutMs: 20000,
  })
  const listening = await api.probePort(port)
  return { blocker, dbPath, run, listening, port }
}

export function assertions(observed) {
  const run = observed.run || {}
  const stderr = String(run.stderrText || '')
  return [
    ['the process exits non-zero instead of starting', run.code !== 0, `code=${run.code} stdout=${String(run.stdoutText || '').slice(0, 200)}`],
    ['stderr names the database path that could not be prepared', stderr.includes(observed.dbPath) || stderr.includes('todos.db'), `stderr=${stderr.slice(0, 300)}`],
    ['nothing is listening on the configured port afterwards', observed.listening === false, `port=${observed.port} listening=${observed.listening}`],
  ]
}
