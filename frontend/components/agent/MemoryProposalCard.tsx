import Link from 'next/link'
import { useTranslation } from 'next-i18next'
import { ArrowRight, Brain } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { formatCurrency } from '@/utils/formatters'
import { MemoryFields, MemoryProposal } from '@/utils/agentApi'

/** One fact as it would be stored: the text verbatim and prominent, then its amount and cadence. */
export function MemoryFact({ fact, muted = false }: { fact: MemoryFields; muted?: boolean }) {
  const { t } = useTranslation('common')
  return <div className={muted ? 'text-muted-foreground' : ''}>
    <p className="whitespace-pre-wrap break-words text-base font-medium">{fact.text}</p>
    <p className="mt-1 text-xs text-muted-foreground">
      {t(`agent.memory.kinds.${fact.kind}`)}
      {fact.amount !== null && fact.currency !== null && ` · ${formatCurrency(Number(fact.amount), fact.currency)}`}
      {fact.cadence !== null && ` · ${t(`agent.memory.cadences.${fact.cadence}`)}`}
    </p>
  </div>
}

export default function MemoryProposalCard({ proposal, expired, expiresLabel, confirmDisabled, discardDisabled, recovering, recoveryChecked, onConfirm, onDiscard, onDismissRecovery }: {
  proposal: MemoryProposal
  // Pending, but past its deadline on this device's clock.
  expired: boolean
  expiresLabel: string
  confirmDisabled: boolean
  discardDisabled: boolean
  // A confirmation whose outcome is unknown; Remember replays the same request.
  recovering: boolean
  recoveryChecked: boolean
  onConfirm: () => void
  onDiscard: () => void
  onDismissRecovery: () => void
}) {
  const { t } = useTranslation('common')
  const { action, before, after } = proposal
  const status = proposal.status === 'pending' && expired ? 'expired' : proposal.status
  const headingId = `memory-proposal-${proposal.id}`
  const forget = action === 'forget'
  // Confirmed but holding no text: the fact was forgotten since (Settings or a later offer).
  const forgotten = forget ? status === 'confirmed' : status === 'confirmed' && after === null

  return <Card>
    <section aria-labelledby={headingId}>
      <CardHeader className="space-y-1">
        <h2 id={headingId} className="flex items-center gap-2 font-semibold leading-none tracking-tight"><Brain className="h-5 w-5 shrink-0" aria-hidden="true" />{t(`agent.memory.title.${action}`)}</h2>
        {status === 'pending' && <p className="text-sm text-muted-foreground">{expiresLabel}</p>}
      </CardHeader>
      <CardContent className="space-y-4">
        {status === 'pending' && <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
          {action === 'update' && before && <>
            <p className="text-xs font-semibold uppercase text-muted-foreground">{t('agent.memory.now')}</p>
            <del className="block"><MemoryFact fact={before} muted /></del>
            <p className="flex items-center gap-1 text-xs font-semibold uppercase text-muted-foreground"><ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />{t('agent.memory.becomes')}</p>
          </>}
          {forget ? before && <MemoryFact fact={before} /> : after && <MemoryFact fact={after} />}
        </div>}
        {status === 'pending' && <>
          <p className="text-sm text-muted-foreground">{t(forget ? 'agent.memory.forgetHint' : 'agent.memory.hint')}</p>
          {recovering && <p className="text-sm">{t('agent.recoverHint')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={confirmDisabled} onClick={onConfirm}>{t(recovering ? 'agent.memory.recoverConfirm' : forget ? 'agent.memory.forget' : 'agent.memory.remember')}</Button>
            {recovering && recoveryChecked && <Button variant="ghost" disabled={discardDisabled} onClick={onDismissRecovery}>{t('agent.dismissRecovery')}</Button>}
            {!recovering && <Button variant="ghost" disabled={discardDisabled} onClick={onDiscard}>{t(forget ? 'agent.memory.keep' : 'agent.memory.notNow')}</Button>}
          </div>
        </>}
        {status === 'confirmed' && (forgotten
          ? <p className="rounded-lg border bg-muted p-3 text-sm">{t('agent.memory.forgotten')}</p>
          : <div className="space-y-3 rounded-lg border border-green-600/30 bg-green-500/10 p-3 text-sm">
            {after && <MemoryFact fact={after} />}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p>{t('agent.memory.saved')}</p>
              <Button variant="outline" size="sm" asChild><Link href="/settings#pocky-memory">{t('agent.memory.manage')}<ArrowRight className="h-4 w-4" /></Link></Button>
            </div>
          </div>)}
        {status === 'cancelled' && <p className="rounded-lg border bg-muted p-3 text-sm">{t(forget ? 'agent.memory.kept' : 'agent.memory.notSaved')}</p>}
        {status === 'expired' && <p className="rounded-lg border bg-muted p-3 text-sm">{t('agent.memory.expired')}</p>}
        {status === 'conflict' && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{t(proposal.error_code === 'agent_memory_full' ? 'agent.memory.full' : 'agent.memory.conflict')}</p>}
      </CardContent>
    </section>
  </Card>
}
