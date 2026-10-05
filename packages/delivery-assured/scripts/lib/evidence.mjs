// Record validation is shared by diagnostics and CI. Transport provenance is
// checked by the CI consumer; an issuer string alone is not authentication.
export const EVIDENCE_GATES = ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment']
const DIGEST = /^[0-9a-f]{64}$/
const REVISION = /^[0-9a-f]{40}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
const text = value => typeof value === 'string' && value.trim() !== '' && !/^(unknown|draft|none|local-)|<[^>]+>/i.test(value)

export function preferProof(previous, next) {
  if (!previous) return next
  if (Boolean(previous.current) !== Boolean(next.current)) return next.current ? next : previous
  if (next.at !== previous.at) return next.at > previous.at ? next : previous
  // Ambiguous order is fail-closed: even passing cases in an ERROR run do not
  // erase the failed build, deployment or incomplete record at the same time.
  if (Boolean(previous.fresh) !== Boolean(next.fresh)) return next.fresh ? previous : next
  if (next.outcome !== 'passed' && previous.outcome === 'passed') return next
  return previous
}

export function validateEvidenceRecord(record) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const b = record?.bindings || {}
  const e = record?.environment || {}
  const x = record?.execution || {}
  need(text(record?.evidence_id), 'missing evidence_id')
  need(text(record?.issuer?.identity), 'missing issuer identity')
  for (const key of ['code_revision', 'contract_revision', 'acceptance_revision', 'verifier_config_revision']) {
    need(REVISION.test(b[key] || ''), `missing or invalid ${key}`)
  }
  for (const key of ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'spine_manifest_digest', 'slice_manifest_digest']) {
    need(DIGEST.test(b[key] || ''), `missing or invalid ${key}`)
  }
  for (const key of ['dependency_lock_digest', 'migration_digest']) {
    need(own(b, key) && (b[key] === null || DIGEST.test(b[key] || '')), `missing or invalid ${key}`)
  }
  need(own(b, 'parent_baseline') && (b.parent_baseline === null || text(b.parent_baseline)), 'missing parent_baseline binding')
  need(['production_like_ci', 'staging'].includes(e.kind), 'environment is not verified CI or staging')
  need(IMAGE.test(e.image_digest || ''), 'missing or invalid image_digest')
  need(IMAGE.test(e.deployed_image_digest || '') && e.deployed_image_digest === e.image_digest, 'deployed image differs from tested image')
  need(REVISION.test(e.deployed_code_revision || '') && e.deployed_code_revision === b.code_revision, 'deployment revision differs from candidate')
  for (const key of ['deployment_id', 'config_fingerprint', 'fixture_revision']) need(text(e[key]), `missing ${key}`)
  need(text(x.ci_run_id), 'missing ci_run_id')
  need(x.result === 'PASS', 'recorded result is not PASS')
  const start = Date.parse(x.started_at)
  const finish = Date.parse(x.finished_at)
  need(Number.isFinite(start) && Number.isFinite(finish) && finish >= start, 'missing or invalid execution timestamps')
  need(x.timed_out !== true && !x.filter, 'execution was timed out or filtered')
  const ids = record?.scope?.required_case_ids
  const results = x.case_results
  need(text(record?.scope?.slice_id), 'missing slice scope')
  need(Array.isArray(ids) && ids.length > 0 && ids.every(text) && new Set(ids).size === ids.length, 'required case scope is empty or duplicated')
  need(Array.isArray(results) && results.length > 0, 'case results are missing')
  if (Array.isArray(ids) && Array.isArray(results)) {
    const resultIds = results.map(r => r?.case_id)
    need(new Set(resultIds).size === resultIds.length, 'duplicate case results')
    need(resultIds.length === ids.length && ids.every(id => resultIds.includes(id)), 'executed set differs from required scope')
    need(results.every(r => r?.outcome === 'passed'), 'a case failed, was skipped, was not run, or has an unknown outcome')
    need(Number.isInteger(x.required_cases) && x.required_cases > 0 && x.required_cases === ids.length, 'required case count does not match scope')
    need(Number.isInteger(x.executed_cases) && x.executed_cases === results.length, 'executed case count does not match results')
  }
  need(x.skipped_required_cases === 0, 'missing or nonzero skipped_required_cases')
  const gates = x.gate_results
  need(Array.isArray(gates) && gates.length === EVIDENCE_GATES.length, 'the complete six gates were not recorded')
  if (Array.isArray(gates)) {
    need(new Set(gates.map(g => g?.gate)).size === gates.length, 'duplicate gate results')
    for (const gate of EVIDENCE_GATES) {
      const g = gates.find(r => r?.gate === gate)
      need(g && g.undeclared !== true && (g.outcome === 'passed' && g.exit_code === 0 || g.outcome === 'not_applicable' && text(g.reason)), `gate ${gate} did not pass or lacks an explicit exclusion`)
    }
  }
  need(Array.isArray(record?.structural_notes) && !record.structural_notes.some(s => /^fail:/.test(s)), 'structural checks failed or were not recorded')
  need(Array.isArray(x.artifacts) && x.artifacts.length > 0 && x.artifacts.every(text), 'verification artifacts were not retained')
  return problems
}
