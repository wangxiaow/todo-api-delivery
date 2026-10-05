#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditCompletedHistory } from './ci-history.mjs'
import { reconciliationPlan, dispatchReconciliation } from './ci-reconcile.mjs'

export async function reconcileVisibleHistory({ repository, token, receipts, request = fetch }) {
  const audit = await auditCompletedHistory({ repository, token, receipts, request })
  // Validate before sorting. Oldest missing attempt first avoids starvation when
  // newer dispatches continuously arrive. One queued request avoids replacing
  // multiple pending collectors under delivery-state-main concurrency.
  reconciliationPlan(audit, { maxDispatches: 1 })
  const missing = [...audit.missing].sort((a, b) => {
    const [ar, aa] = a.split('-').map(Number), [br, ba] = b.split('-').map(Number)
    return ar - br || aa - ba
  })
  const sorted = { ...audit, missing, blockers: missing.map(key => `completed verification attempt ${key} has no durable receipt; reconcile before Candidate execution`) }
  return dispatchReconciliation({ repository, token, plan: reconciliationPlan(sorted, { maxDispatches: 1 }), request })
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.DSH_RECONCILE_ENVIRONMENT !== 'main-history-planner') throw new Error('trusted main reconciliation context required')
  if (process.argv.length !== 3) throw new Error('one restored receipts directory is required')
  const directory = resolve(process.argv[2])
  const receipts = existsSync(directory) ? readdirSync(directory).map(name => {
    if (!/^[1-9]\d*-[1-9]\d*\.json$/.test(name)) throw new Error('unexpected receipt filename')
    return JSON.parse(readFileSync(join(directory, name), 'utf8'))
  }) : []
  const report = await reconcileVisibleHistory({ repository: process.env.GITHUB_REPOSITORY, token: process.env.DSH_ACTIONS_DISPATCH_TOKEN, receipts })
  console.log(JSON.stringify(report, null, 2))
  if (report.failures.length) process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('ci-reconcile: source audit or dispatch failed; history remains unresolved'); process.exitCode = 2 })
