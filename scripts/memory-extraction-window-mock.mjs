// Scheduling-only mock. Inputs contain IDs and safety classifications, not text.
// No model, persistence, token budgeting, retries or crash recovery is simulated.
export function simulateWindows(turns, strategy, observationEnd) {
  if (!['B', 'C'].includes(strategy)) throw new Error('Unsupported strategy')
  const batches = [], groups = new Map(), sessionState = new Map()
  let lastUserAt = null
  const emit = (group, at, reason) => {
    if (!group.pending.length) return
    const fresh = group.pending.splice(0, 4)
    const visible = fresh.filter(turn => turn.kind === 'visible').map(turn => turn.id)
    if (visible.length) batches.push({ session: group.session, scope: group.scope, epoch: group.epoch,
      newIds: visible, gapIds: fresh.filter(turn => turn.kind !== 'visible').map(turn => turn.id), prefixIds: [...group.prefix], at, reason })
    group.prefix = [...group.prefix, ...visible].slice(-2)
  }
  const idle = at => {
    if (strategy !== 'C' || lastUserAt === null || at < lastUserAt + 60_000) return
    for (const group of groups.values()) while (group.pending.length) emit(group, lastUserAt + 60_000, 'idle')
    lastUserAt = null
  }
  for (const turn of [...turns].sort((a, b) => a.at - b.at)) {
    if (turn.at > observationEnd) break
    idle(turn.at)
    const previous = sessionState.get(turn.session)
    const epoch = previous ? previous.epoch + Number(previous.scope !== turn.scope) : 0
    sessionState.set(turn.session, { scope: turn.scope, epoch })
    const key = JSON.stringify([turn.session, turn.scope, epoch])
    if (!groups.has(key)) groups.set(key, { session: turn.session, scope: turn.scope, epoch, pending: [], prefix: [] })
    const group = groups.get(key)
    group.pending.push({ id: turn.id, kind: turn.kind })
    lastUserAt = turn.at
    if (group.pending.length >= 4) emit(group, turn.at, 'size')
  }
  idle(observationEnd)
  return { batches, pendingTurns: [...groups.values()].reduce((sum, group) => sum + group.pending.length, 0) }
}
