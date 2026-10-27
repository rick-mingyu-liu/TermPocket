import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Brain, MessageSquare, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'next-i18next'
import { formatDay } from '@/lib/date'
import { agentAPI, MemoryFact as Fact } from '@/utils/agentApi'
import { MemoryFact } from '@/components/agent/MemoryProposalCard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog'

/**
 * Settings → Pocky memory: every fact Pocky remembers, with Delete on each and
 * Forget all. Neither involves the model. Hidden while conversation storage is
 * off or the server reports memory unavailable (before its migration).
 */
export default function PockyMemory() {
  const { t, i18n } = useTranslation('common')
  // null until the server answers; the section stays hidden meanwhile.
  const [memories, setMemories] = useState<Fact[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [forgetOpen, setForgetOpen] = useState(false)

  const load = useCallback(async () => {
    const status = await agentAPI.status()
    if (!status.storage) return setMemories(null)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const result = await agentAPI.memories(timezone)
    setMemories(result.available ? result.memories : null)
  }, [])

  useEffect(() => {
    // A failed read leaves the section hidden rather than showing a wrong list.
    load().catch(() => setMemories(null))
  }, [load])

  // The card's "Manage memory" link lands on #pocky-memory, which exists only
  // once the list has loaded, after the browser's own jump to the anchor.
  const scrolled = useRef(false)
  useEffect(() => {
    if (memories === null || scrolled.current || window.location.hash !== '#pocky-memory') return
    scrolled.current = true
    document.getElementById('pocky-memory')?.scrollIntoView({ block: 'start' })
  }, [memories])

  const remove = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      await agentAPI.deleteMemory(id)
      setMemories(previous => previous?.filter(fact => fact.id !== id) ?? null)
      toast.success(t('agent.memory.settings.deleted'))
    } catch {
      toast.error(t('agent.memory.settings.error'))
      await load().catch(() => undefined)
    } finally { setBusy(false) }
  }

  const forgetAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      await agentAPI.forgetAllMemories()
      setMemories([])
      setForgetOpen(false)
      toast.success(t('agent.memory.settings.forgotAll'))
    } catch {
      toast.error(t('agent.memory.settings.error'))
      await load().catch(() => undefined)
    } finally { setBusy(false) }
  }

  if (memories === null) return null
  return (
    <Card id="pocky-memory">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5" />
          {t('agent.memory.settings.title')}
        </CardTitle>
        <CardDescription>{t('agent.memory.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {memories.length === 0
          ? <p className="text-sm text-muted-foreground">{t('agent.memory.settings.empty')}</p>
          : <ul className="divide-y rounded-lg border">
            {memories.map(fact => <li key={fact.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <MemoryFact fact={fact} />
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{t('agent.memory.settings.savedOn', { date: formatDay(fact.saved_on, i18n.language) })}</span>
                  {fact.source_conversation_id && <Link href={`/agent?conversation=${encodeURIComponent(fact.source_conversation_id)}`} className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                    <MessageSquare className="h-3 w-3" aria-hidden="true" />{t('agent.memory.settings.source')}
                  </Link>}
                </p>
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void remove(fact.id)} aria-label={t('agent.memory.settings.deleteLabel', { text: fact.text })}>
                <Trash2 className="h-4 w-4" />{t('agent.memory.settings.delete')}
              </Button>
            </li>)}
          </ul>}
        <p className="text-sm text-muted-foreground">{t('agent.memory.settings.caveat')}</p>
        {memories.length > 0 && <Button variant="destructive" disabled={busy} onClick={() => setForgetOpen(true)}>{t('agent.memory.settings.forgetAll')}</Button>}
      </CardContent>
      <Dialog open={forgetOpen} onOpenChange={open => { if (!busy) setForgetOpen(open) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agent.memory.settings.forgetAllTitle')}</DialogTitle>
            <DialogDescription>{t('agent.memory.settings.forgetAllWarning')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline" disabled={busy}>{t('Cancel')}</Button></DialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void forgetAll()}>{t('agent.memory.settings.forgetAll')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
