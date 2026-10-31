import { useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'
import { ArrowLeft, Loader2, MessageSquare, Mic, Plus, RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import DraftEditor, { currencies, selectClass } from '@/components/agent/DraftEditor'
import GoalProposalCard from '@/components/agent/GoalProposalCard'
import MemoryProposalCard from '@/components/agent/MemoryProposalCard'
import { readPreferences } from '@/lib/preferences'
import { DICTATION_LIMIT_MS, dictationSupported, useDictation } from '@/lib/voice/useDictation'
import { agentAPI, agentErrorCode, agentOutcomeUnknown, AgentContext, ConfirmRequest, Conversation, ConversationState, DraftRow, GoalConfirmRequest, MemoryConfirmRequest, MessageRequest, ReplyLanguage } from '@/utils/agentApi'
import { api } from '@/utils/api'

// Visiting or updating a conversation must not change its place in history.
const creationOrder = (items: Conversation[]) => [...items].sort((a, b) =>
  Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
// The column default in schema.sql, kept until the first message names it.
const DEFAULT_TITLE = 'New conversation'
// Must equal the server's amount rule in services/agent/validation.ts.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,7})\.\d{2}$/
// How many of the user's most recent transaction descriptions the transcriber
// may learn merchant names from (the API's largest page; the worker's prompt
// keeps at most 40 of them, letters only).
const VOCABULARY_LIMIT = 200
// A transcript still counts as in the composer while at least half of its
// words are there: edits keep a dictated message flagged, typing over it does not.
const holdsTranscript = (content: string, transcript: string) => {
  const text = content.toLowerCase()
  const words = transcript.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.filter(word => text.includes(word)).length * 2 >= words.length
}

export default function AgentPage() {
  const { t, i18n } = useTranslation('common')
  const router = useRouter()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [storage, setStorage] = useState<boolean | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [state, setState] = useState<ConversationState | null>(null)
  const [context, setContext] = useState<AgentContext>({ currency: 'CAD', timezone: 'America/Toronto', language: 'auto' })
  const [content, setContent] = useState('')
  const [rows, setRows] = useState<DraftRow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [retry, setRetry] = useState<{ conversationId: string; body: MessageRequest } | null>(null)
  const [confirmRetry, setConfirmRetry] = useState<ConfirmRequest | null>(null)
  // A failed recovery was followed by a successful state refresh, so the
  // pending draft is known to be unconfirmed and recovery may be dismissed.
  const [confirmChecked, setConfirmChecked] = useState(false)
  // A goal confirmation whose outcome is unknown, replayed with its requestId.
  const [goalRetry, setGoalRetry] = useState<GoalConfirmRequest | null>(null)
  const [goalChecked, setGoalChecked] = useState(false)
  // The same for a memory offer's Remember (or Forget) button.
  const [memoryRetry, setMemoryRetry] = useState<MemoryConfirmRequest | null>(null)
  const [memoryChecked, setMemoryChecked] = useState(false)
  // The server rejected a save or confirmation because the draft moved on.
  const [staleDraft, setStaleDraft] = useState(false)
  const composer = useRef<HTMLTextAreaElement | null>(null)
  const focusComposer = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const activeRequest = useRef<{ conversationId: string; requestId: string } | null>(null)
  const generation = useRef(0)
  const [now, setNow] = useState(Date.now())
  // Transcripts inserted into the composer since it was last empty. The text
  // counts as dictated (edited or not) while it still holds one of them.
  const [transcripts, setTranscripts] = useState<string[]>([])
  const voiced = transcripts.some(transcript => holdsTranscript(content, transcript))
  // Decided after mount: the server cannot know whether this browser can record.
  const [canDictate, setCanDictate] = useState(false)
  useEffect(() => { setCanDictate(dictationSupported()) }, [])
  useEffect(() => { if (!content.trim()) setTranscripts([]) }, [content])
  // The transcriber's vocabulary: the user's most recent transaction
  // descriptions, newest first (the API orders by date DESC, id DESC), read
  // once per visit and only when the user dictates. They stay in this tab and
  // the dictation worker; nothing new leaves the browser. A failed read means
  // no vocabulary, never a dialog (`background`) or a failed dictation.
  const vocabulary = useRef<Promise<string[]> | null>(null)
  const dictationTerms = () => {
    vocabulary.current ??= api.get<{ transactions: { description: string | null }[] }>('/transactions', { params: { limit: VOCABULARY_LIMIT }, background: true })
      .then(response => response.data.transactions.map(row => row.description ?? '').filter(Boolean))
      .catch(() => [])
    return vocabulary.current
  }
  // Insert the transcript at the cursor (or append), never replacing what is there.
  const dictation = useDictation(text => {
    const box = composer.current
    setContent(previous => {
      // The textarea keeps its selection after the mic button takes focus.
      const start = Math.min(box?.selectionStart ?? previous.length, previous.length)
      const end = Math.min(box?.selectionEnd ?? previous.length, previous.length)
      const before = previous.slice(0, start), after = previous.slice(end)
      const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`
      return (before + insert + after).slice(0, 4000)
    })
    setTranscripts(previous => [...previous, text])
    box?.focus()
  }, dictationTerms)
  // Recording or transcribing: a transcript is on its way into this composer.
  // Loading the model is not: Send stays usable while it downloads.
  const dictating = dictation.state.status === 'recording' || dictation.state.status === 'transcribing'
  const micLabel = dictation.state.status === 'recording' ? 'agent.voice.stop' : dictation.state.status === 'loading' ? 'agent.voice.cancelLoad' : 'agent.voice.start'

  const apply = (next: ConversationState) => {
    // Until an uncertain save settles, show exactly the edits its retry will save.
    const pendingConfirmation = confirmRetry && next.conversation.id === state?.conversation.id
      && next.draft?.status === 'pending' && next.draft.version === confirmRetry.version
      && !next.receipts.some(receipt => receipt.request_id === confirmRetry.requestId)
    const pendingRows = next.draft?.status === 'pending'
      ? (pendingConfirmation && confirmRetry.rows ? confirmRetry.rows : next.draft.rows) : []
    const sameConversation = state?.conversation.id === next.conversation.id
    const newProposal = next.draft?.version !== state?.draft?.version
      && (next.run?.id !== state?.run?.id || (state?.run?.status === 'running' && next.run?.status === 'complete'))
    setState(next)
    setContext({ currency: next.conversation.currency, timezone: next.conversation.timezone, language: next.conversation.language })
    setRows(pendingRows)
    // Editing, refreshing, and confirming a subset must not silently select
    // rows the user excluded. A new proposal starts its own reviewed selection.
    setSelected(previous => pendingConfirmation ? confirmRetry.rowIds : !sameConversation || newProposal
      ? pendingRows.map(row => row.id)
      : previous.filter(id => pendingRows.some(row => row.id === id)))
    setConversations(previous => creationOrder([next.conversation, ...previous.filter(item => item.id !== next.conversation.id)]))
    setNow(Date.now())
  }
  const showError = (cause: unknown) => setError(agentErrorCode(cause))

  useEffect(() => {
    if (!localStorage.getItem('token')) { void router.replace('/login'); return }
    const preferences = readPreferences()
    setContext({ currency: currencies.includes(preferences.currency) ? preferences.currency : 'CAD', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Toronto', language: preferences.language === 'system' ? 'auto' : preferences.language })
    let live = true
    agentAPI.status().then(async status => {
      if (!live) return
      setAvailable(status.available); setStorage(status.storage)
      if (!status.storage) return
      // Existing history remains accessible when the provider is disabled.
      const items = await agentAPI.list()
      if (live) setConversations(creationOrder(items))
      // Settings links a remembered fact to the conversation it came from.
      const linked = new URLSearchParams(window.location.search).get('conversation')
      if (live && linked && items.some(item => item.id === linked)) void load(linked)
    }).catch(cause => { if (live) showError(cause) })
    return () => { live = false; generation.current += 1; controller.current?.abort() }
    // Initialize once; changing the display language must not restart a turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Local expiry updates are timers, never network polling.
  useEffect(() => {
    const deadlines = [state?.draft?.expires_at, state?.goalProposal?.expires_at, state?.memoryProposal?.expires_at, ...(state?.receipts.map(receipt => receipt.undo_until) || [])]
      .filter((value): value is string => Boolean(value)).map(value => new Date(value).getTime()).filter(value => value > Date.now())
    if (!deadlines.length) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...deadlines) - Date.now() + 20)
    return () => clearTimeout(timer)
  }, [state, now])

  const dirty = Boolean(state?.draft?.status === 'pending' && JSON.stringify(rows) !== JSON.stringify(state.draft.rows))
  const running = sending || state?.run?.status === 'running'
  const locked = busy || Boolean(running) || cancelling
  const unresolved = Boolean(retry || confirmRetry || goalRetry || memoryRetry)
  const sendDisabled = locked || unresolved || dirty || available !== true || !content.trim() || dictating
  // Coarse pointer = phone/tablet: Enter stays a newline there and Send is the button.
  const [enterSends, setEnterSends] = useState(false)
  useEffect(() => { setEnterSends(!window.matchMedia('(pointer: coarse)').matches) }, [])
  const pendingDraft = state?.draft?.status === 'pending'
  const expired = Boolean(state?.draft && new Date(state.draft.expires_at).getTime() <= now)
  const validRows = rows.length > 0 && rows.every(row => AMOUNT_PATTERN.test(row.amount) && Number(row.amount) > 0 && row.description.trim() && row.date)
  // Deadlines name their zone, since the date timezone may not be the device's.
  const dateTime = (value: string, zone = false) => {
    const options: Intl.DateTimeFormatOptions = zone ? { timeZoneName: 'short' } : {}
    try { return new Date(value).toLocaleString(i18n.language, { ...options, timeZone: context.timezone || undefined }) }
    catch { return new Date(value).toLocaleString(i18n.language, options) }
  }
  // A recovered request can report a run still executing elsewhere.
  const stillProcessing = state?.run?.status === 'running' && !sending

  // Return focus to the composer once a send or deletion has re-enabled it.
  useEffect(() => {
    if (!focusComposer.current || locked) return
    focusComposer.current = false
    composer.current?.focus()
  })

  const load = async (id: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await agentAPI.get(id)
      apply(next)
      if (next.run?.status !== 'running') setRetry(null)
      setConfirmRetry(null); setGoalRetry(null); setMemoryRetry(null); setStaleDraft(false)
    } catch (cause) { showError(cause) } finally { setBusy(false) }
  }

  const refresh = async () => {
    setBusy(true); setError('')
    try {
      const status = await agentAPI.status(); setAvailable(status.available); setStorage(status.storage)
      if (!status.storage) return
      setConversations(creationOrder(await agentAPI.list()))
      const conversationId = state?.conversation.id || retry?.conversationId
      if (conversationId) {
        const next = await agentAPI.get(conversationId); apply(next)
        // Nothing running: the saved request either finished (its reply is in
        // this state) or never started (its text is still in the composer).
        if (next.run?.status !== 'running') setRetry(null)
        // Keep an uncertain confirmation's exact request for safe replay,
        // unless the goal proposal it targets has visibly settled.
        if (goalRetry && (next.goalProposal?.id !== goalRetry.proposalId || next.goalProposal.status !== 'pending')) setGoalRetry(null)
        if (memoryRetry && (next.memoryProposal?.id !== memoryRetry.proposalId || next.memoryProposal.status !== 'pending')) setMemoryRetry(null)
      }
      setStaleDraft(false)
    } catch (cause) { showError(cause) } finally { setBusy(false) }
  }

  const send = async (attempt?: { conversationId: string; body: MessageRequest }) => {
    // A replay keeps its requestId, so it may go out without a provider: the
    // server answers an exact replay from saved state and refuses a new run.
    if (locked || dirty || confirmRetry || (!available && !attempt) || (!attempt && (!content.trim() || dictating))) return
    setBusy(true); setSending(true); setError(''); setNotice(''); setStaleDraft(false)
    const thisGeneration = ++generation.current
    const abort = new AbortController(); controller.current = abort
    let request = attempt
    try {
      const conversationId = attempt?.conversationId || state?.conversation.id || (await agentAPI.create(context, abort.signal)).id
      // Cancellation can happen while the initial conversation is being
      // created. Even if creation committed, never send its message afterward.
      if (generation.current !== thisGeneration || abort.signal.aborted) return
      request = attempt || { conversationId, body: { ...context, content: content.trim(), requestId: crypto.randomUUID(), ...(voiced ? { input: 'voice' as const } : {}) } }
      activeRequest.current = { conversationId, requestId: request.body.requestId }
      setRetry(request)
      const next = await agentAPI.send(conversationId, request.body, abort.signal)
      if (generation.current !== thisGeneration) return
      apply(next); setRetry(null); setContent(''); dictation.clearError(); focusComposer.current = next.run?.status !== 'running'
      if (next.run?.error_code) setError(next.run.error_code)
    } catch (cause) {
      if (generation.current !== thisGeneration) return
      showError(cause)
      // Unknown transport outcomes retain the exact request ID. Explicit
      // server failures can be retried as a fresh turn after status refresh.
      if (request && !agentOutcomeUnknown(cause)) {
        try {
          const next = await agentAPI.get(request.conversationId)
          if (generation.current === thisGeneration) { apply(next); setRetry(null) }
        } catch { /* Preserve the recovery request. */ }
      }
    } finally {
      if (generation.current === thisGeneration) { setBusy(false); setSending(false); controller.current = null; activeRequest.current = null }
    }
  }

  const cancel = async () => {
    const target = activeRequest.current || (state?.run?.status === 'running' ? { conversationId: state.conversation.id, requestId: state.run.id } : retry ? { conversationId: retry.conversationId, requestId: retry.body.requestId } : null)
    if (!target) {
      if (controller.current) {
        generation.current += 1
        controller.current.abort(); controller.current = null
        setSending(false); setBusy(false); setRetry(null); setError(''); setNotice('agent.cancelled')
      }
      return
    }
    setCancelling(true); setError('')
    try {
      await agentAPI.cancel(target.conversationId, target.requestId)
      generation.current += 1; controller.current?.abort()
      const next = await agentAPI.get(target.conversationId)
      apply(next); setRetry(null)
      if (next.run?.status === 'cancelled') setNotice('agent.cancelled')
    } catch (cause) { showError(cause) } finally {
      setCancelling(false)
      if (controller.current?.signal.aborted) { setSending(false); setBusy(false); activeRequest.current = null; controller.current = null }
    }
  }

  const mutateDraft = async (action: 'edit' | 'discard' | 'confirm', all = false) => {
    if (!state || (!state.draft && !confirmRetry) || locked || retry) return
    setBusy(true); setError(''); setNotice(''); setStaleDraft(false)
    const recovering = action === 'confirm' && confirmRetry
    const body = action !== 'confirm' ? null : confirmRetry || { version: state.draft!.version, rowIds: all ? rows.map(row => row.id) : selected, requestId: crypto.randomUUID(), ...(dirty ? { rows } : {}) }
    try {
      let next: ConversationState
      if (action === 'edit') next = await agentAPI.edit(state.conversation.id, state.draft!.version, rows)
      else if (action === 'discard') next = await agentAPI.discard(state.conversation.id, state.draft!.version)
      else {
        setConfirmRetry(body); setConfirmChecked(false)
        next = await agentAPI.confirm(state.conversation.id, body!)
        setConfirmRetry(null); setNotice('agent.saved')
      }
      apply(next)
    } catch (cause) {
      showError(cause)
      const code = agentErrorCode(cause)
      if (action !== 'discard' && (code === 'agent_version_conflict' || code === 'agent_expired')) setStaleDraft(true)
      // The router's catch-all 500 may follow a commit, so it stays recoverable.
      if (action === 'confirm' && !agentOutcomeUnknown(cause) && code !== 'agent_request_failed') setConfirmRetry(null)
      else if (recovering && body) {
        // A replay failed again: check what the server holds. A draft that is no
        // longer pending at this version, or a receipt for this request, means
        // the request can no longer apply, so there is nothing left to recover.
        try {
          const next = await agentAPI.get(state.conversation.id)
          apply(next)
          const settled = next.draft?.status !== 'pending' || next.draft.version !== body.version
            || next.receipts.some(receipt => receipt.request_id === body.requestId)
          if (settled) setConfirmRetry(null)
          else setConfirmChecked(true)
        } catch { /* Keep the exact request for another recovery attempt. */ }
      }
    } finally { setBusy(false) }
  }

  const mutateGoal = async (action: 'confirm' | 'discard') => {
    const proposal = state?.goalProposal
    if (!state || !proposal || locked || retry || confirmRetry || (action === 'discard' && goalRetry)) return
    if (action === 'confirm' && dirty) return
    setBusy(true); setError(''); setNotice('')
    const recovering = action === 'confirm' && goalRetry
    const body = action === 'confirm' ? goalRetry || { proposalId: proposal.id, requestId: crypto.randomUUID() } : null
    try {
      let next: ConversationState
      if (action === 'discard') next = await agentAPI.discardGoal(state.conversation.id, proposal.id)
      else {
        setGoalRetry(body); setGoalChecked(false)
        next = await agentAPI.confirmGoal(state.conversation.id, body!)
        setGoalRetry(null)
        if (next.goalProposal?.status === 'confirmed') setNotice(proposal.action === 'update' ? 'agent.goal.updated' : 'agent.goal.created')
      }
      apply(next)
      if (action === 'discard') setNotice('agent.goal.discarded')
    } catch (cause) {
      const code = agentErrorCode(cause)
      // Scoped so the alert names the goal rather than the transaction draft.
      setError(`goal:${code}`)
      // The router's catch-all 500 may follow a commit, so it stays recoverable.
      const definite = !agentOutcomeUnknown(cause) && code !== 'agent_request_failed'
      if (action === 'confirm' && definite) setGoalRetry(null)
      // A definite refusal, or a replay that failed again: show what the server
      // holds. A proposal no longer pending under this id cannot apply any more.
      if (action === 'discard' || definite || (recovering && body)) {
        try {
          const next = await agentAPI.get(state.conversation.id)
          apply(next)
          if (recovering && body) {
            if (next.goalProposal?.id !== body.proposalId || next.goalProposal.status !== 'pending') setGoalRetry(null)
            else setGoalChecked(true)
          }
        } catch { /* Keep any exact request for another recovery attempt. */ }
      }
    } finally { setBusy(false) }
  }

  const mutateMemory = async (action: 'confirm' | 'discard') => {
    const proposal = state?.memoryProposal
    if (!state || !proposal || locked || retry || confirmRetry || goalRetry || (action === 'discard' && memoryRetry)) return
    setBusy(true); setError(''); setNotice('')
    const recovering = action === 'confirm' && memoryRetry
    const body = action === 'confirm' ? memoryRetry || { proposalId: proposal.id, requestId: crypto.randomUUID() } : null
    try {
      let next: ConversationState
      if (action === 'discard') next = await agentAPI.discardMemory(state.conversation.id, proposal.id)
      else {
        setMemoryRetry(body); setMemoryChecked(false)
        next = await agentAPI.confirmMemory(state.conversation.id, body!)
        setMemoryRetry(null)
      }
      apply(next)
    } catch (cause) {
      const code = agentErrorCode(cause)
      // The offer is gone (Forget all in Settings): the card it came from is
      // stale, so show the current state and no error.
      const gone = code === 'agent_memory_proposal_gone'
      if (!gone) setError(`memory:${code}`)
      // The router's catch-all 500 may follow a commit, so it stays recoverable.
      const definite = !agentOutcomeUnknown(cause) && code !== 'agent_request_failed'
      if (action === 'confirm' && definite) setMemoryRetry(null)
      if (action === 'discard' || definite || (recovering && body)) {
        try {
          const next = await agentAPI.get(state.conversation.id)
          apply(next)
          if (recovering && body) {
            if (next.memoryProposal?.id !== body.proposalId || next.memoryProposal.status !== 'pending') setMemoryRetry(null)
            else setMemoryChecked(true)
          }
        } catch { /* Keep any exact request for another recovery attempt. */ }
      }
    } finally { setBusy(false) }
  }

  const removeConversation = async () => {
    if (!state) return
    setBusy(true); setError('')
    try {
      await agentAPI.remove(state.conversation.id)
      setConversations(previous => previous.filter(item => item.id !== state.conversation.id))
      setState(null); setRows([]); setContent(''); setRetry(null); setConfirmRetry(null); setGoalRetry(null); setMemoryRetry(null); setStaleDraft(false); setDeleteOpen(false); setNotice('agent.deleted')
      focusComposer.current = true
    } catch (cause) { showError(cause) } finally { setBusy(false) }
  }

  const undo = async (id: string) => {
    if (!state) return
    setBusy(true); setError(''); setNotice('')
    try { await agentAPI.undo(id); apply(await agentAPI.get(state.conversation.id)); setNotice('agent.undone') }
    catch (cause) { showError(cause) } finally { setBusy(false) }
  }

  const dismissRecovery = () => { setConfirmRetry(null); setConfirmChecked(false) }
  const statusText = cancelling ? 'agent.cancelling' : stillProcessing ? 'agent.stillProcessing' : running ? 'agent.working'
    : notice || (storage === null && !error ? 'agent.checking' : '')

  return <>
    <Head><title>{`${t('agent.title')} - TermPocket`}</title></Head>
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card"><div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-6">
        <Button variant="ghost" size="icon" asChild><Link href="/" aria-label={t('agent.back')}><ArrowLeft /></Link></Button>
        <div><h1 className="flex items-center gap-2 text-2xl font-bold"><MessageSquare className="h-6 w-6" />{t('agent.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('agent.subtitle')}</p></div>
      </div></header>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
        <p className="rounded-lg border bg-card p-3 text-xs leading-relaxed text-muted-foreground">{t('agent.privacy')}{' '}<Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">{t('agent.privacyLink')}</Link></p>
        {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">{error.startsWith('goal:')
          ? t(`agent.goal.errors.${error.slice(5)}`, { defaultValue: t(`agent.errors.${error.slice(5)}`, { defaultValue: t('agent.errors.generic') }) })
          : error.startsWith('memory:')
            ? t(`agent.memory.errors.${error.slice(7)}`, { defaultValue: t(`agent.errors.${error.slice(7)}`, { defaultValue: t('agent.errors.generic') }) })
            : t(`agent.errors.${error}`, { defaultValue: t('agent.errors.generic') })}</div>}
        {/* The single live region; the visible notices below are not announced twice. */}
        <p role="status" aria-live="polite" className="sr-only">{statusText ? t(statusText) : ''}</p>
        {notice && <p className="rounded-lg border border-green-600/30 bg-green-500/10 p-3 text-sm">{t(notice)}</p>}
        {storage === null && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('agent.checking')}</p>}
        {storage === false && <p className="rounded-lg border bg-muted p-4 text-sm">{t('agent.disabled')}</p>}
        {storage && available === false && <p className="rounded-lg border bg-muted p-4 text-sm">{t('agent.unavailable')}</p>}
        {storage !== false && <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-3">
            <div className="flex flex-wrap gap-2"><Button disabled={locked || dirty || unresolved || dictating} onClick={() => { setState(null); setRows([]); setContent(''); setNotice(''); setError(''); dictation.clearError() }}><Plus />{t('agent.new')}</Button><Button variant="outline" size="icon" aria-label={t('agent.refresh')} disabled={busy || (dirty && !staleDraft) || sending} onClick={refresh}><RefreshCw /></Button></div>
            <h2 className="text-sm font-semibold">{t('agent.history')}</h2>
            <div className="flex max-h-64 gap-2 overflow-auto lg:max-h-[65vh] lg:flex-col">
              {conversations.map(item => <button key={item.id} disabled={locked || dirty || unresolved || dictating} onClick={() => load(item.id)} aria-current={state?.conversation.id === item.id ? 'page' : undefined} className={`min-w-40 rounded-lg border p-3 text-left text-sm hover:bg-muted disabled:opacity-50 lg:min-w-0 ${state?.conversation.id === item.id ? 'border-primary bg-primary/5' : ''}`}><span className="line-clamp-2 break-words">{!item.title || item.title === DEFAULT_TITLE ? t('agent.untitled') : item.title}</span><time dateTime={item.created_at} className="mt-1 block text-xs text-muted-foreground">{dateTime(item.created_at)}</time></button>)}
              {!conversations.length && <p className="text-sm text-muted-foreground">{t('agent.noHistory')}</p>}
            </div>
          </aside>
          <div className="min-w-0 space-y-5">
            <Card><CardContent className="space-y-4 pt-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm"><span>{t('agent.defaultCurrency')}</span><select className={selectClass} value={context.currency} disabled={locked || unresolved} onChange={e => setContext({ ...context, currency: e.target.value })}>{currencies.map(currency => <option key={currency}>{currency}</option>)}</select></label>
                <label className="space-y-1 text-sm"><span>{t('agent.timezone')}</span><Input value={context.timezone} disabled={locked || unresolved} onChange={e => setContext({ ...context, timezone: e.target.value })} /></label>
                <label className="space-y-1 text-sm"><span>{t('agent.replyLanguage')}</span><select className={selectClass} value={context.language} disabled={locked || unresolved} onChange={e => setContext({ ...context, language: e.target.value as ReplyLanguage })}><option value="auto">{t('agent.autoLanguage')}</option><option value="en">English</option><option value="zh">中文</option></select></label>
              </div>
              <p className="text-xs text-muted-foreground">{t('agent.contextHint')}</p>
              <div className="space-y-4" role="log" aria-live="polite" aria-label={t('agent.messages')}>
                {!state?.messages.length && <div className="rounded-lg bg-muted/50 p-5"><p className="font-medium">{t('agent.start')}</p><p className="mt-2 text-sm text-muted-foreground">{t('agent.example')}</p><p className="mt-1 text-sm text-muted-foreground">{t('agent.exampleQuestion')}</p><p className="mt-1 text-sm text-muted-foreground">{t('agent.examplePlan')}</p></div>}
                {state?.messages.map(message => <div key={message.id} className={`max-w-full whitespace-pre-wrap break-words rounded-lg p-4 text-sm ${message.role === 'user' ? 'ml-4 bg-primary/10 sm:ml-12' : 'mr-4 bg-muted sm:mr-12'}`}><p className="mb-2 text-xs font-semibold text-muted-foreground">{t(message.role === 'user' ? 'agent.you' : 'agent.assistant')}</p>{message.content}{message.status !== 'complete' && <p className="mt-2 text-xs text-muted-foreground">{t(`agent.messageStatus.${message.status}`)}</p>}</div>)}
              </div>
              {running && <div className="flex flex-wrap items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t(cancelling ? 'agent.cancelling' : stillProcessing ? 'agent.stillProcessing' : 'agent.working')}{stillProcessing && !cancelling && <Button variant="outline" size="sm" disabled={busy || dirty} onClick={refresh}><RefreshCw />{t('agent.refreshNow')}</Button>}<Button variant="outline" size="sm" disabled={cancelling} onClick={cancel}>{t('agent.cancel')}</Button></div>}
              {retry && !running && <div className="space-y-2 rounded-lg border p-3 text-sm"><p>{t('agent.recoverHint')}</p><Button variant="outline" disabled={locked} onClick={() => send(retry)}>{t('agent.recover')}</Button></div>}
              {(state?.run?.status === 'failed' || state?.run?.status === 'cancelled') && !retry && <div className="space-y-2"><p className="text-sm text-muted-foreground">{t('agent.failedHint')}</p><Button variant="outline" disabled={locked || dirty || unresolved || !available} onClick={() => {
                const previous = [...state.messages].reverse().find(message => message.role === 'user')
                if (previous) void send({ conversationId: state.conversation.id, body: { ...context, content: previous.content, requestId: crypto.randomUUID() } })
              }}>{t('agent.retryNew')}</Button></div>}
              <form onSubmit={event => { event.preventDefault(); void send() }} className="space-y-3">
                <label className="block space-y-2 text-sm"><span className="font-medium">{t('agent.compose')}</span><Textarea ref={composer} rows={3} maxLength={4000} value={content} onChange={e => { setContent(e.target.value); dictation.clearError() }} onKeyDown={e => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
                  // Plain Enter sends only with a fine pointer; Cmd/Ctrl+Enter always does.
                  if (!(e.metaKey || e.ctrlKey || enterSends)) return
                  e.preventDefault()
                  if (!sendDisabled) e.currentTarget.form?.requestSubmit()
                }} disabled={locked || unresolved || available !== true} placeholder={t('agent.placeholder')} /></label>
                {canDictate && dictation.state.status === 'loading' && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{dictation.state.total ? t('agent.voice.loading', { loaded: (dictation.state.loaded / 1e6).toFixed(1), total: (dictation.state.total / 1e6).toFixed(1) }) : t('agent.voice.preparing')}</p>}
                {canDictate && dictation.state.status === 'recording' && <p className="flex items-center gap-2 text-xs"><span className="h-2 w-2 animate-pulse rounded-full bg-red-600" aria-hidden />{t('agent.voice.recording', { elapsed: Math.min(Math.floor(dictation.state.elapsed / 1000), DICTATION_LIMIT_MS / 1000), limit: DICTATION_LIMIT_MS / 1000 })}</p>}
                {canDictate && dictation.state.status === 'ready' && <p className="text-xs text-muted-foreground">{t('agent.voice.ready')}</p>}
                {canDictate && dictation.state.status === 'transcribing' && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t('agent.voice.transcribing')}</p>}
                {canDictate && dictation.error && <p role="alert" className="text-xs text-destructive">{t(`agent.voice.errors.${dictation.error}`)}</p>}
                {voiced && !dictating && <p className="text-xs text-muted-foreground">{t('agent.voice.review')}</p>}
                <div className="flex items-center justify-between gap-3"><div className="space-y-1"><p className="text-xs text-muted-foreground">{t('agent.reviewHint')}</p>{enterSends && <p className="text-xs text-muted-foreground">{t('agent.enterHint')}</p>}</div><div className="flex shrink-0 items-center gap-2">
                  {canDictate && <Button type="button" variant="outline" size="icon" aria-pressed={dictation.state.status === 'recording'}
                    aria-label={t(micLabel)} title={t(micLabel)}
                    // A recording can always be stopped and a download cancelled; starting one needs a usable composer and no pending run.
                    disabled={dictation.state.status === 'recording' || dictation.state.status === 'loading' ? false
                      : dictation.state.status === 'transcribing' || locked || unresolved || available !== true}
                    onClick={() => void dictation.toggle()}>
                    {dictation.state.status === 'recording' ? <Square className="fill-current text-red-600" /> : dictation.state.status === 'idle' || dictation.state.status === 'ready' ? <Mic /> : <Loader2 className="animate-spin" />}
                  </Button>}
                  <Button type="submit" disabled={sendDisabled}><Send />{t('agent.send')}</Button></div></div>
              </form>
              {state && <div className="border-t pt-3"><Button variant="ghost" size="sm" disabled={locked || unresolved || dictating} onClick={() => setDeleteOpen(true)}><Trash2 />{t('agent.deleteConversation')}</Button></div>}
            </CardContent></Card>
            {state?.draft?.status === 'expired' && <p className="rounded-lg border p-4 text-sm">{t('agent.expired')}</p>}
            {pendingDraft && <Card><CardHeader><CardTitle>{t('agent.review')}</CardTitle><p className="text-sm text-muted-foreground">{t('agent.version', { version: state.draft?.version })} · {expired ? t('agent.expired') : t('agent.expires', { date: dateTime(state.draft!.expires_at, true) })}</p></CardHeader><CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('agent.draftHint')}</p>
              <DraftEditor rows={rows} selected={selected} disabled={locked || unresolved || expired} onChange={setRows} onSelect={setSelected} />
              {dirty && <p className="text-sm">{t('agent.unsaved')}</p>}
              {staleDraft && <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><p>{t(dirty ? 'agent.staleDraftDirty' : 'agent.staleDraft')}</p><Button variant="outline" size="sm" disabled={busy || sending} onClick={refresh}><RefreshCw />{t('agent.refreshDraft')}</Button></div>}
              {!validRows && <p className="text-sm text-destructive">{t('agent.invalidRows')}</p>}
              <div className="flex flex-wrap gap-2">
                {confirmRetry ? <><Button disabled={locked} onClick={() => mutateDraft('confirm')}>{t('agent.recoverConfirm')}</Button>{confirmChecked && <Button variant="ghost" disabled={locked} onClick={dismissRecovery}>{t('agent.dismissRecovery')}</Button>}</> : <><Button disabled={locked || unresolved || !validRows || expired || !selected.length} onClick={() => mutateDraft('confirm')}>{t('agent.confirmSelected', { count: selected.length })}</Button><Button variant="outline" disabled={locked || unresolved || !validRows || expired} onClick={() => mutateDraft('confirm', true)}>{t('agent.confirmAll')}</Button></>}
                {dirty && !confirmRetry && <><Button disabled={locked || unresolved || !validRows || expired} variant="ghost" onClick={() => mutateDraft('edit')}>{t('agent.saveEdits')}</Button><Button disabled={locked || unresolved} variant="ghost" onClick={() => setRows(state.draft!.rows)}>{t('agent.resetEdits')}</Button></>}
                <Button variant="ghost" disabled={locked || unresolved} onClick={() => mutateDraft('discard')}>{t('agent.discard')}</Button>
              </div>
            </CardContent></Card>}
            {confirmRetry && !pendingDraft && <div className="flex flex-wrap gap-2"><Button disabled={locked} onClick={() => mutateDraft('confirm')}>{t('agent.recoverConfirm')}</Button>{confirmChecked && <Button variant="ghost" disabled={locked} onClick={dismissRecovery}>{t('agent.dismissRecovery')}</Button>}</div>}
            {state?.goalProposal && <GoalProposalCard
              proposal={state.goalProposal}
              expired={new Date(state.goalProposal.expires_at).getTime() <= now}
              expiresLabel={t('agent.expires', { date: dateTime(state.goalProposal.expires_at, true) })}
              confirmDisabled={locked || dirty || Boolean(retry || confirmRetry)}
              discardDisabled={locked || Boolean(retry || confirmRetry)}
              recovering={Boolean(goalRetry)}
              recoveryChecked={goalChecked}
              onConfirm={() => void mutateGoal('confirm')}
              onDiscard={() => void mutateGoal('discard')}
              onDismissRecovery={() => { setGoalRetry(null); setGoalChecked(false) }} />}
            {state?.memoryProposal && <MemoryProposalCard
              proposal={state.memoryProposal}
              expired={new Date(state.memoryProposal.expires_at).getTime() <= now}
              expiresLabel={t('agent.expires', { date: dateTime(state.memoryProposal.expires_at, true) })}
              confirmDisabled={locked || Boolean(retry || confirmRetry || goalRetry)}
              discardDisabled={locked || Boolean(retry || confirmRetry || goalRetry)}
              recovering={Boolean(memoryRetry)}
              recoveryChecked={memoryChecked}
              onConfirm={() => void mutateMemory('confirm')}
              onDiscard={() => void mutateMemory('discard')}
              onDismissRecovery={() => { setMemoryRetry(null); setMemoryChecked(false) }} />}
            {state?.receipts.map(receipt => <Card key={receipt.id}><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5"><div><p className="font-medium">{t(receipt.undone_at ? 'agent.receiptUndone' : 'agent.receiptSaved', { count: receipt.transaction_ids.length })}</p><p className="mt-1 text-xs text-muted-foreground">{receipt.undone_at ? dateTime(receipt.undone_at) : new Date(receipt.undo_until).getTime() <= now ? t('agent.undoExpired') : t('agent.undoUntil', { date: dateTime(receipt.undo_until, true) })}</p></div>{!receipt.undone_at && <Button variant="outline" disabled={locked || dirty || unresolved || new Date(receipt.undo_until).getTime() <= now} onClick={() => undo(receipt.id)}>{t('agent.undo')}</Button>}</CardContent></Card>)}
          </div>
        </div>}
      </main>
    </div>
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent onCloseAutoFocus={event => {
      // The trigger is gone with its conversation; continue at the composer.
      if (!state) { event.preventDefault(); composer.current?.focus() }
    }}><DialogHeader><DialogTitle>{t('agent.deleteConversation')}</DialogTitle><DialogDescription>{t('agent.deleteWarning')}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleteOpen(false)}>{t('agent.cancel')}</Button><Button variant="destructive" disabled={busy} onClick={removeConversation}>{t('agent.deleteConversation')}</Button></DialogFooter></DialogContent></Dialog>
  </>
}

export async function getStaticProps({ locale }: { locale: string }) {
  return { props: { ...(await serverSideTranslations(locale, ['common'])) } }
}
