import { InputError } from './common.mjs'

// This set comes from the frozen manifest, Slice and parent Spine, never from a
// test runner's self-reported list of the cases it happened to execute.
export function scopeForSlice(model, sliceId) {
  const slice = model.slices.find(s => s.id === sliceId || s.lineage?.includes(sliceId))
  if (!slice) throw new InputError(`unknown Slice ${sliceId}`)
  const caseIds = requiredCaseIds(model, sliceId)
  const surface = new Set([...(slice.obligations || []), ...(slice.outcomes || [])])
  for (const c of model.acceptance.cases) if (caseIds.includes(c.id)) for (const id of [...(c.obligation_ids || []), ...(c.outcome_ids || [])]) surface.add(id)
  // A partial Journey Slice proves its declared results, not the eventual whole
  // Journey. The whole-Contract view still aggregates every Required child.
  for (const journey of model.contract.journeys || []) {
    const children = [...(journey.outcomes || []), ...(journey.exceptional_outcomes || [])].filter(o => o.required !== false)
    const explicit = children.filter(o => (slice.outcomes || []).includes(o.id))
    if (explicit.length && children.some(o => !surface.has(o.id))) surface.delete(journey.id)
  }
  return { slice, caseIds, obligationIds: [...surface] }
}

export function requiredCaseIds(model, sliceId = null) {
  const automated = model.acceptance.cases.filter(c => c.required === true && c.method === 'automated')
  const byId = new Map(automated.map(c => [c.id, c]))
  if (byId.size !== automated.length) throw new InputError('duplicate Required acceptance case id')
  const slice = sliceId ? model.slices.find(s => s.id === sliceId || s.lineage?.includes(sliceId)) : null
  if (sliceId && !slice) throw new InputError(`unknown Slice ${sliceId}`)
  const requested = new Set(slice ? slice.acceptance || [] : byId.keys())
  if (slice && requested.size === 0) throw new InputError(`Slice ${sliceId} declares no acceptance`)
  for (const id of model.spine.caseIds) requested.add(id)
  if (slice) {
    const surfaces = new Set([...(slice.obligations || []), ...(slice.outcomes || [])])
    for (const c of model.acceptance.cases) if (requested.has(c.id)) for (const id of [...(c.obligation_ids || []), ...(c.outcome_ids || [])]) surfaces.add(id)
    const critical = new Set((model.contract.business_rules || []).filter(r => r.severity === 'critical' && surfaces.has(r.id)).map(r => r.id))
    for (const c of automated) if ((c.obligation_ids || []).some(id => critical.has(id))) requested.add(c.id)
  }
  const ids = [...requested].filter(id => {
    const c = model.acceptance.cases.find(c => c.id === id)
    if (!c) throw new InputError(`unknown acceptance case ${id} in Slice or Spine`)
    if (c.method === 'manual' && !model.spine.caseIds.includes(id)) return false
    if (!byId.has(id)) throw new InputError(`Spine or Slice case ${id} is not Required automated acceptance`)
    return true
  }).sort()
  if (ids.length === 0) throw new InputError('zero Required machine acceptance cases')
  return ids
}
