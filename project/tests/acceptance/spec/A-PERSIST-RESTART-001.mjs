export const id = 'A-PERSIST-RESTART-001'
export const title = '进程重启后已提交的 Todo 仍然存在，且 schema 版本不变'

export default async function run(api) {
  const first = await api.startServer()
  let second = null
  try {
    const created = (await api.request(first, {
      method: 'POST',
      path: '/api/v1/todos',
      token: 'alice-secret',
      body: { title: 'survive the restart', notes: 'durable' },
    })).body
    const before = await api.request(first, { method: 'GET', path: '/version' })
    const stopped = await api.stopServer(first)
    second = await api.restartServer(first)
    const readBack = await api.request(second, { method: 'GET', path: `/api/v1/todos/${created.id}`, token: 'alice-secret' })
    const listed = await api.request(second, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
    const after = await api.request(second, { method: 'GET', path: '/version' })
    return { created, before, after, stopped, readBack, listed }
  } finally {
    if (second) await api.stopServer(second)
    else await api.stopServer(first)
  }
}

export function assertions(observed) {
  const readBack = observed.readBack.body || {}
  const created = observed.created || {}
  const items = (observed.listed.body && observed.listed.body.items) || []
  return [
    ['the restart did not fail the process', observed.stopped.code === 0 || observed.stopped.signal === 'SIGTERM' || observed.stopped.code === null, `stopped=${JSON.stringify(observed.stopped)}`],
    ['the todo is readable after the restart with the same id, title and version', observed.readBack.status === 200 && readBack.id === created.id && readBack.title === 'survive the restart' && readBack.version === created.version, `readBack=${JSON.stringify(readBack)}`],
    ['created_at is unchanged', readBack.created_at === created.created_at, `before=${created.created_at} after=${readBack.created_at}`],
    ['the collection contains exactly one todo, so nothing was duplicated', items.length === 1 && items[0].id === created.id, `items=${JSON.stringify(items)}`],
    ['the restarted process reports the same schema version', observed.after.body && observed.after.body.schema_version === (observed.before.body && observed.before.body.schema_version), `before=${JSON.stringify(observed.before.body)} after=${JSON.stringify(observed.after.body)}`],
  ]
}
