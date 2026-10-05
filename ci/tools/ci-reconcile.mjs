// Diagnostic planning only: a queued collector is not a durable receipt, evidence,
// or permission to execute a Candidate. Authentication belongs to the CI caller.
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$(?![\s\S])/
const KEY = /^([1-9]\d*)-([1-9]\d*)$(?![\s\S])/
const positive = n => Number.isSafeInteger(n) && n > 0
const count = n => Number.isSafeInteger(n) && n >= 0
const blocker = key => `completed verification attempt ${key} has no durable receipt; reconcile before Candidate execution`
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function identity(key) {
  const match = typeof key === 'string' && KEY.exec(key)
  if (!match || !positive(Number(match[1])) || !positive(Number(match[2]))) throw new Error('invalid exact run-attempt key')
  return { run_key: key, run_id: Number(match[1]), run_attempt: Number(match[2]) }
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

export function reconciliationPlan(historyAudit, { maxDispatches = 3 } = {}) {
  if (!positive(maxDispatches)) throw new Error('invalid reconciliation dispatch cap')
  if (!exactKeys(historyAudit, ['diagnostic_only', 'examined', 'completed', 'missing', 'blockers']) || historyAudit.diagnostic_only !== true || !count(historyAudit.examined) || !count(historyAudit.completed) || historyAudit.completed > historyAudit.examined || !Array.isArray(historyAudit.missing) || !Array.isArray(historyAudit.blockers)) throw new Error('invalid completed history audit')
  const missing = [...historyAudit.missing]
  const entries = missing.map(identity)
  if (new Set(missing).size !== missing.length || missing.length > historyAudit.completed || !equal(historyAudit.blockers, missing.map(blocker))) throw new Error('duplicate identities or dishonest history audit counts/blockers')
  return {
    diagnostic_only: true,
    examined: historyAudit.examined,
    completed: historyAudit.completed,
    missing,
    blockers: missing.map(blocker),
    max_dispatches: maxDispatches,
    dispatches: entries.slice(0, maxDispatches),
    unresolved: missing.slice(maxDispatches)
  }
}

function validatePlan(plan) {
  if (!exactKeys(plan, ['diagnostic_only', 'examined', 'completed', 'missing', 'blockers', 'max_dispatches', 'dispatches', 'unresolved'])) throw new Error('invalid reconciliation plan')
  const expected = reconciliationPlan({ diagnostic_only: plan.diagnostic_only, examined: plan.examined, completed: plan.completed, missing: plan.missing, blockers: plan.blockers }, { maxDispatches: plan.max_dispatches })
  if (!Array.isArray(plan.dispatches) || !Array.isArray(plan.unresolved) || !equal(plan.unresolved, expected.unresolved) || plan.dispatches.length !== expected.dispatches.length || Array.from(plan.dispatches).some((entry, index) => !exactKeys(entry, ['run_key', 'run_id', 'run_attempt']) || entry.run_key !== expected.dispatches[index].run_key || entry.run_id !== expected.dispatches[index].run_id || entry.run_attempt !== expected.dispatches[index].run_attempt)) throw new Error('reconciliation plan selection was altered')
  return expected
}

export async function dispatchReconciliation({ repository, token, plan, request = fetch }) {
  if (typeof repository !== 'string' || !REPO.test(repository) || repository.split('/').some(part => part === '.' || part === '..') || typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token) || typeof request !== 'function') throw new Error('invalid reconciliation dispatch configuration')
  const checked = validatePlan(plan)
  const queued = [], failures = [], attempted = []
  for (const entry of checked.dispatches) {
    attempted.push(entry.run_key)
    try {
      const response = await request(`https://api.github.com/repos/${repository}/actions/workflows/promote.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ ref: 'main', inputs: { mode: 'record-attempt', verify_run_id: String(entry.run_id), verify_run_attempt: String(entry.run_attempt) } })
      })
      // Do not inspect bodies or propagate transport errors: they may expose secrets.
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected === true) {
        failures.push({ run_key: entry.run_key, kind: 'ambiguous-response' })
        break
      }
      if (response.status === 204) queued.push(entry.run_key)
      else failures.push({ run_key: entry.run_key, kind: 'http', status: response.status })
    } catch {
      // The server might have accepted this POST. Never retry it or dispatch the
      // remaining selection in this invocation after an ambiguous transport loss.
      failures.push({ run_key: entry.run_key, kind: 'transport-unknown' })
      break
    }
  }
  const accepted = new Set(queued)
  return {
    diagnostic_only: true,
    status: failures.length ? (queued.length ? 'partial' : 'failed') : 'queued',
    queued,
    attempted,
    failures,
    // No confirmed 204, not proof that an ambiguous POST never reached GitHub.
    // Consult attempted/failures before deciding whether to retry independently.
    unsubmitted: checked.missing.filter(key => !accepted.has(key)),
    // Even HTTP 204 does not prove receipt persistence. Only a fresh independent
    // history audit against stored receipts can remove these blockers.
    unresolved: [...checked.missing],
    missing: [...checked.missing],
    blockers: [...checked.blockers]
  }
}
