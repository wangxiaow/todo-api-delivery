import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

export function validateArtifact(dir, evidence) {
  const root = resolve(dir)
  const manifest = JSON.parse(readFileSync(join(root, 'ARTIFACT.json'), 'utf8'))
  if (manifest.code_revision !== evidence.bindings.code_revision) throw new Error('artifact code revision mismatch')
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('artifact is empty')
  const seen = new Set()
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(entry.path) || entry.path.split('/').includes('..') || entry.path.startsWith('/') || seen.has(entry.path)) throw new Error('invalid artifact entry path')
    seen.add(entry.path)
    const path = resolve(root, entry.path)
    const bytes = readFileSync(path)
    if (lstatSync(path).isSymbolicLink() || bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('artifact bytes mismatch')
  }
  const text = `${manifest.entries.map((e) => `${e.path}\t${e.bytes}\t${e.sha256}`).join('\n')}\n`
  const digest = createHash('sha256').update(text).digest('hex')
  if (manifest.digest !== digest || readFileSync(join(root, 'MANIFEST.tsv'), 'utf8') !== text || evidence.environment.image_digest !== `sha256:${digest}` || evidence.environment.deployed_image_digest !== `sha256:${digest}`) throw new Error('artifact digest binding mismatch')
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('artifact symlink')
      if (entry.isDirectory()) walk(path)
      else {
        const name = relative(root, path).replace(/\\/g, '/')
        if (!['ARTIFACT.json', 'MANIFEST.tsv'].includes(name) && !seen.has(name)) throw new Error('unmanifested artifact byte')
      }
    }
  }
  walk(root)
  return manifest
}
