// The flow registry. Each flow: { name, description, covers: [routes], needs: ['db'|'audio'],
// run(ctx) } where ctx = { page, step, session, repo, token, user, env }.
// Steps throw to fail; a step may return { warn: '...' } to pass with a note.

import { agent, dictate } from './agent.mjs'
import { dashboard, login, pages, settings } from './core.mjs'
import { importFlow } from './import.mjs'
import { goals, transactionCrud, transactions } from './records.mjs'

export const flows = [login, dashboard, transactions, transactionCrud, goals, importFlow, agent, dictate, settings, pages]

export function findFlows(names) {
  if (names.length === 0 || names.includes('all')) return flows
  const out = []
  for (const n of names) {
    const f = flows.find(f => f.name === n)
    if (!f) throw new Error(`unknown flow "${n}"; run \`ctl flows\``)
    out.push(f)
  }
  return out
}
