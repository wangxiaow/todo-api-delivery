import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FILES = ['.agent/attempts.jsonl', '.agent/reviews.yaml', '.agent/STANDARD_CHANGES.yaml', 'ci/mvp-ready.json', 'tests/spine/manifest.yaml']
const TREES = ['ci/recording', 'ci/evidence', 'ci/baseline']
const SCOPES = [...FILES, ...TREES]
const scoped = path => FILES.includes(path) || TREES.some(root => path === root || path.startsWith(`${root}/`))
const ancestor = path => SCOPES.some(root => root.startsWith(`${path}/`))
const safePath = path => typeof path === 'string' && path.length > 0 && path.split('/').every(part =>
  /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))

const safeRelative = path => path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' &&
  !/[\\\\:\x00-\x1f\x7f\ufffd]/.test(part) && !/[. ]$/.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: null, shell: false, maxBuffer: 128 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`state snapshot Git read failed: ${result.error?.message || result.stderr?.toString().trim() || result.status}`)
  return result.stdout
}

function stat(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function directory(path) {
  const info = stat(path)
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error(`state snapshot directory is missing or nonregular: ${path}`)
}

// Validate BEFORE extracting project from a state archive. Byte checks of scoped
// files alone do not stop an archive from overwriting Contract/config/source.
export function assertStateTree({ repo, stateSha, stateProject = 'project' }) {
  if (!isAbsolute(repo || '') || !/^[0-9a-f]{40}$/.test(stateSha || '') || !safePath(stateProject)) throw new Error('invalid state tree configuration')
  if (git(repo, ['cat-file', '-t', stateSha]).toString().trim() !== 'commit') throw new Error('state tree must identify a commit')
  let count = 0
  for (const entry of git(repo, ['ls-tree', '-r', '-z', '--full-tree', stateSha]).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry)
    if (!match) throw new Error('invalid state tree entry')
    const [, mode, type, , path] = match
    if (path === stateProject || stateProject.startsWith(`${path}/`)) throw new Error('nonregular state project ancestor')
    if (!path.startsWith(`${stateProject}/`)) continue // Not part of project archive.
    const file = path.slice(stateProject.length + 1)
    if (!scoped(file)) throw new Error(`state project entry outside durable scopes: ${file}`)
    if (!safeRelative(file) || !['100644', '100755'].includes(mode) || type !== 'blob' || TREES.includes(file) || FILES.some(leaf => file.startsWith(`${leaf}/`))) throw new Error(`nonregular or unsafe state project entry: ${file}`)
    count++
  }
  return Object.freeze({ diagnostic_only: true, state_sha: stateSha, state_project: stateProject, file_count: count })
}

// This is a read-only byte binding to a caller-selected protected snapshot, not
// an authenticity decision. The caller must independently establish protection.
export function assertStateSnapshot(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('invalid state snapshot configuration')
  for (const key of Reflect.ownKeys(options)) {
    if (!['repo', 'stateSha', 'project', 'stateProject'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) throw new Error('unsupported state snapshot option')
  }
  const { repo, stateSha, project, stateProject = 'project' } = options
  if (typeof stateSha !== 'string' || !/^[0-9a-f]{40}$/.test(stateSha)) throw new Error('state snapshot revision must be an exact lowercase SHA40')
  if (!safePath(stateProject)) throw new Error('unsafe state snapshot project path')
  for (const [name, value] of [['repo', repo], ['project', project]]) {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`invalid state snapshot ${name} path`)
  }
  // Checking all ancestors prevents a seemingly ordinary project reached through
  // a symlink/junction from silently reading a different restored state root.
  for (let path = resolve(project); ; path = dirname(path)) {
    directory(path)
    if (dirname(path) === path) break
  }
  if (git(repo, ['cat-file', '-t', stateSha]).toString().trim() !== 'commit') throw new Error('state snapshot revision must identify a commit')
  const expected = new Map()
  const prefix = `${stateProject}/`
  const listing = git(repo, ['ls-tree', '-r', '-z', '--full-tree', stateSha])
  for (const entry of listing.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry)
    if (!match) throw new Error('invalid state snapshot Git tree entry')
    const [, mode, type, , path] = match
    if (path === stateProject || stateProject.startsWith(`${path}/`)) throw new Error(`nonregular Git state project ancestor: ${path}`)
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    if (!scoped(relative) && !ancestor(relative) && !FILES.some(file => relative.startsWith(`${file}/`))) continue
    if (ancestor(relative) || !['100644', '100755'].includes(mode) || type !== 'blob') throw new Error(`nonregular Git state entry: ${relative}`)
    if (!safeRelative(relative)) throw new Error(`unsafe Git state path: ${relative}`)
    // Exact leaf scopes must be files, whereas the recursive scopes are dirs.
    if (TREES.includes(relative) || FILES.some(file => relative.startsWith(`${file}/`))) throw new Error(`invalid Git state layout: ${relative}`)
    expected.set(relative, path)
  }

  const actual = new Map()
  function inspect(relative, recursive = false) {
    const path = join(project, ...relative.split('/'))
    const info = stat(path)
    if (!info) return
    if (info.isSymbolicLink()) throw new Error(`symlink in restored state: ${relative}`)
    if (recursive && info.isDirectory()) {
      for (const name of readdirSync(path)) {
        const child = `${relative}/${name}`
        if (!safeRelative(child)) throw new Error(`unsafe restored state path: ${child}`)
        inspect(child, true)
      }
    } else if (info.isFile() && !TREES.includes(relative)) actual.set(relative, path)
    else throw new Error(`unsupported restored state file type: ${relative}`)
  }
  for (const scope of SCOPES) {
    const parts = scope.split('/')
    let present = true
    for (let i = 1; i < parts.length; i++) {
      const parent = join(project, ...parts.slice(0, i))
      if (!stat(parent)) { present = false; break }
      directory(parent)
    }
    if (present) inspect(scope, TREES.includes(scope))
  }
  const missing = [...expected.keys()].filter(path => !actual.has(path))
  const extra = [...actual.keys()].filter(path => !expected.has(path))
  if (missing.length || extra.length) throw new Error(`state snapshot path mismatch; missing: ${missing.sort().join(', ') || '(none)'}; extra: ${extra.sort().join(', ') || '(none)'}`)
  for (const [relative, path] of expected) {
    if (!readFileSync(actual.get(relative)).equals(git(repo, ['show', `${stateSha}:${path}`]))) throw new Error(`state snapshot bytes mismatch: ${relative}`)
  }
  return Object.freeze({ diagnostic_only: true, state_sha: stateSha, state_project: stateProject, file_count: expected.size })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {}
    for (let i = 0; i < args.length; i++) {
      const key = args[i]
      if (!['--check-tree', '--repo'].includes(key) || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('expected --check-tree <SHA40> [--repo <repository>]')
      options[key] = args[++i]
    }
    console.log(JSON.stringify(assertStateTree({ repo: resolve(options['--repo'] || '.'), stateSha: options['--check-tree'] })))
  } catch (error) { console.error(`STATE TREE BLOCKED ${error.message}`); process.exitCode = 2 }
}
