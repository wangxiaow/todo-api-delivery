export const id = 'A-STARTUP-CLI-001'
export const title = '启动方式由文档化入口点提供：--help 说明子命令，migrate 只准备数据库'

export default async function run(api) {
  const help = await api.runCli({ args: ['--help'] })
  const dbPath = api.newDbPath()
  const migrate = await api.runCli({ args: ['migrate'], env: { TODO_DB_PATH: dbPath }, timeoutMs: 30000 })
  const readme = api.readText('README.md')
  return {
    helpText: `${help.stdoutText || ''}${help.stderrText || ''}`,
    helpCode: help.code,
    migrateCode: migrate.code,
    migrateOutput: `${migrate.stdoutText || ''}${migrate.stderrText || ''}`,
    dbExists: api.fileExists(dbPath),
    readme,
  }
}

export function assertions(observed) {
  const help = String(observed.helpText || '')
  const readme = String(observed.readme || '')
  return [
    ['--help exits 0 and prints usage', observed.helpCode === 0 && /usage/i.test(help), `code=${observed.helpCode} text=${help.slice(0, 200)}`],
    ['--help names the serve and migrate subcommands', /\bserve\b/.test(help) && /\bmigrate\b/.test(help), `text=${help.slice(0, 300)}`],
    ['the migrate subcommand prepares the database and exits 0', observed.migrateCode === 0 && observed.dbExists === true, `code=${observed.migrateCode} dbExists=${observed.dbExists} output=${String(observed.migrateOutput).slice(0, 200)}`],
    ['the README documents starting the API with the serve entry point', readme.includes('npm start') && /\bserve\b/.test(readme), `readmeHasStart=${readme.includes('npm start')}`],
  ]
}
