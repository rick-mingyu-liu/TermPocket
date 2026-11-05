import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import { ArrowRight, Check, LayoutDashboard, Lock, MessageCircle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentAPI } from '@/utils/agentApi'
import { markTourSeen } from '@/lib/onboarding'
import { cn } from '@/lib/utils'
import TourDialog, { TourPocky as Pocky, tourDelay as delay, type TourStep } from './TourDialog'
import s from './OnboardingTour.module.css'

type StepId = 'welcome' | 'add' | 'pocky' | 'goals' | 'done'

interface OnboardingTourProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function WelcomeArt() {
  const { t } = useTranslation('common')
  const terms = ['Winter', 'Spring', 'Fall']
  return (
    <>
      <div className="absolute inset-x-0 top-5 flex justify-center gap-2">
        {terms.map((term, i) => (
          <span
            key={term}
            className={cn(s.chip, 'relative rounded-full border bg-background/90 px-3 py-1 text-xs font-medium shadow-sm', s.ink)}
            style={delay(250 + i * 140)}
          >
            <span
              className={cn(s.chipGlow, 'absolute inset-0 rounded-full ring-2 ring-[color:var(--tour-leaf)]')}
              style={delay(1200 + i * 1500)}
            />
            {t(term)}
          </span>
        ))}
      </div>
      <div className={cn(s.peek, 'absolute bottom-[-1.25rem] left-1/2 -ml-14')}>
        <div className={s.bob}>
          <Pocky className="h-28 w-28 drop-shadow-md" />
        </div>
      </div>
    </>
  )
}

function AddArt() {
  const rows = [
    { amount: '−$12.50', dot: 'bg-rose-500', w: 'w-12' },
    { amount: '−$3.25', dot: 'bg-cyan-500', w: 'w-9' },
    { amount: '+$640.00', dot: 'bg-emerald-500', w: 'w-14' },
  ]
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3 px-4">
      {/* A screenshot being read on the device */}
      <div className="relative h-36 w-[5.5rem] shrink-0 overflow-hidden rounded-xl border-2 border-[color:var(--tour-ink)] bg-background/95 p-2 shadow-sm">
        <div className="mx-auto mb-2 h-1 w-6 rounded-full bg-muted-foreground/30" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="mb-2 flex items-center justify-between gap-1">
            <div className="h-1.5 w-9 rounded bg-muted-foreground/30" />
            <div className="h-1.5 w-4 rounded bg-muted-foreground/45" />
          </div>
        ))}
        <div className={cn(s.scan, 'absolute inset-x-0 top-1 h-6')} style={{ background: 'linear-gradient(to bottom, transparent, rgba(135, 224, 158, 0.6), transparent)' }} />
        <span className={cn('absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full text-white', s.leafBg)}>
          <Lock className="h-3 w-3" />
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div className={s.guide} style={delay(200)}>
          <Pocky className="h-9 w-9" />
        </div>
        <ArrowRight className={cn(s.flow, 'h-5 w-5', s.leafText)} />
      </div>
      {/* The rows it becomes */}
      <div className="flex w-36 shrink-0 flex-col gap-2">
        {rows.map((row, i) => (
          <div
            key={row.amount}
            className={cn(s.slideIn, 'flex items-center gap-2 rounded-lg border bg-background/95 px-2.5 py-2 shadow-sm')}
            style={delay(600 + i * 280)}
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', row.dot)} />
            <span className={cn('h-1.5 rounded bg-muted-foreground/35', row.w)} />
            <span className="ml-auto text-[11px] font-semibold tabular-nums text-foreground">{row.amount}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PockyArt() {
  const { t } = useTranslation('common')
  return (
    <div className="absolute inset-0 flex items-center justify-center px-4">
      <div className="flex w-64 max-w-full flex-col gap-2">
        <div className={cn(s.bubble, 'ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-sm')} style={delay(150)}>
          {t('onboarding.art.message')}
        </div>
        <div className="relative flex items-end gap-2">
          <Pocky className="h-8 w-8 shrink-0" />
          <div className={cn(s.typing, 'absolute left-10 bottom-1 flex gap-1 rounded-2xl rounded-bl-sm border bg-background px-3 py-2')}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={cn(s.typingDot, 'h-1.5 w-1.5 rounded-full bg-muted-foreground')} style={delay(i * 150)} />
            ))}
          </div>
          <div className={cn(s.bubble, 'flex-1 rounded-2xl rounded-bl-sm border bg-background/95 p-2 shadow-sm')} style={delay(1700)}>
            <div className="mb-1.5 flex items-center gap-2 text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
              <span className="text-muted-foreground">{t('Dining Out')}</span>
              <span className="ml-auto font-semibold tabular-nums">$12.50</span>
            </div>
            <div className="mb-2 flex items-center gap-2 text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" />
              <span className="text-muted-foreground">{t('Transportation')}</span>
              <span className="ml-auto font-semibold tabular-nums">$3.25</span>
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <span className={cn(s.check, 'flex h-5 w-5 items-center justify-center rounded-full text-white', s.leafBg)}>
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              <span className={cn(s.press, 'inline-block rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground')}>
                {t('onboarding.art.confirm')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function GoalsArt() {
  const { t } = useTranslation('common')
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3 px-4">
      <div className={cn(s.guide, 'shrink-0 self-end mb-6')} style={delay(100)}>
        <Pocky className="h-14 w-14" />
      </div>
      <div className="relative w-48 shrink-0">
        <div className={cn(s.coin, 'absolute -top-7 left-[52%] z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 border-amber-600 bg-amber-300 text-xs font-bold text-amber-800 shadow')}>
          $
        </div>
        <div className="rounded-xl border bg-background/95 p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">{t('onboarding.art.goal')}</span>
            <span className={cn(s.floatUp, 'rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white', s.leafBg)}>+$120</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-muted">
            <div className={cn(s.grow, 'h-full w-[62%] rounded-full', s.leafBg)} />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
            <span>$620</span>
            <span>$1,000</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function DoneArt() {
  const sparkles = [
    'left-[22%] top-6', 'right-[22%] top-8', 'left-[30%] bottom-8', 'right-[28%] bottom-6',
  ]
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {[0, 1].map((i) => (
        <span
          key={i}
          className={cn(s.ripple, 'absolute h-28 w-28 rounded-full border-2 border-[color:var(--tour-leaf)]')}
          style={delay(i * 1200)}
        />
      ))}
      {sparkles.map((pos, i) => (
        <svg key={pos} viewBox="0 0 24 24" className={cn(s.twinkle, 'absolute h-4 w-4', pos, s.leafText)} style={delay(i * 350)} aria-hidden="true">
          <path fill="currentColor" d="M12 0l2.6 9.4L24 12l-9.4 2.6L12 24l-2.6-9.4L0 12l9.4-2.6z" />
        </svg>
      ))}
      <div className={s.cheer}>
        <Pocky className="h-24 w-24 drop-shadow-md" />
      </div>
    </div>
  )
}

const ART: Record<StepId, () => JSX.Element> = {
  welcome: WelcomeArt,
  add: AddArt,
  pocky: PockyArt,
  goals: GoalsArt,
  done: DoneArt,
}

/**
 * The first-run tour: four or five short steps, each with a small animated
 * picture. The Pocky step and the "Try Pocky" button appear only where
 * conversation recording is enabled (the same `storage` flag AgentPanel uses).
 * Any way of closing it — finishing, Skip, Esc, the close button or one of the
 * last step's actions — records it as seen for this account.
 */
export default function OnboardingTour({ open, onOpenChange }: OnboardingTourProps) {
  const { t } = useTranslation('common')
  const router = useRouter()
  const [pocky, setPocky] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    // Steps are only ever added once the answer arrives, never removed, so the
    // step on screen always stays in the list.
    agentAPI.status().then((status) => { if (live) setPocky(status.storage) }).catch(() => {})
    return () => { live = false }
  }, [open])

  const steps = useMemo<TourStep[]>(
    () => (pocky ? ['welcome', 'add', 'pocky', 'goals', 'done'] as const : ['welcome', 'add', 'goals', 'done'] as const).map((id: StepId) => ({
      id,
      Art: ART[id],
      title: t(`onboarding.${id}.title`),
      body: id === 'done' && !pocky ? t('onboarding.done.bodyNoPocky') : t(`onboarding.${id}.body`),
    })),
    [pocky, t],
  )

  const close = () => {
    markTourSeen()
    onOpenChange(false)
  }
  const go = (path: string) => {
    close()
    router.push(path)
  }

  return (
    <TourDialog
      open={open}
      steps={steps}
      onClose={close}
      finish={
        <div className="grid gap-2">
          <Button onClick={() => go('/transactions/new')}>
            <Plus />
            {t('onboarding.actions.add')}
          </Button>
          {pocky && (
            <Button variant="outline" onClick={() => go('/agent')}>
              <MessageCircle />
              {t('onboarding.actions.pocky')}
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            <LayoutDashboard />
            {t('onboarding.actions.explore')}
          </Button>
        </div>
      }
    />
  )
}
