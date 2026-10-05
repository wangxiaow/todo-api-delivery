export const id = 'A-MIGRATION-001'
export const title = '空路径首次启动完成迁移，第二次启动幂等且版本一致'

export default async function run(api) {
  const dbPath = api.newDbPath()
  const first = await api.startServer({ dbPath })
  let second = null
  try {
    const firstVersion = await api.request(first, { method: 'GET', path: '/version' })
    await api.stopServer(first)
    second = await api.restartServer(first)
    const secondVersion = await api.request(second, { method: 'GET', path: '/version' })
    return { dbPath, firstVersion, secondVersion, fileExists: api.fileExists(dbPath) }
  } finally {
    if (second) await api.stopServer(second)
    else await api.stopServer(first)
  }
}

export function assertions(observed) {
  const first = observed.firstVersion.body || {}
  const second = observed.secondVersion.body || {}
  return [
    ['the first start reports schema_version 1 through /version', observed.firstVersion.status === 200 && first.schema_version === 1, `body=${JSON.stringify(first)}`],
    ['the second start reports the same schema_version', second.schema_version === first.schema_version, `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`],
    ['the second start applies no second migration', second.migrations_applied === 1 && first.migrations_applied === 1, `first=${first.migrations_applied} second=${second.migrations_applied}`],
    ['the database file exists on disk after startup', observed.fileExists === true, `dbPath=${observed.dbPath} exists=${observed.fileExists}`],
  ]
}
