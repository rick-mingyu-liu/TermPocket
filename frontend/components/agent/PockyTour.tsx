import { useMemo, useRef } from 'react'
import { useTranslation } from 'next-i18next'
import { Check, Mic, PenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import TourDialog, { TourPocky as Pocky, tourDelay as delay, type TourStep } from '@/components/onboarding/TourDialog'
import { cn } from '@/lib/utils'
import s from '@/components/onboarding/OnboardingTour.module.css'

interface PockyTourProps {
  open: boolean
  /** However it closes: Skip, Esc, the close button or Start writing. */
  onClose: () => void
  /** After Start writing has closed it: focus the composer. */
  onStart: () => void
  enterSends: boolean
  canDictate: boolean
  /** The conversation settings as they are now, shown on the settings step. */
  settings: string[]
}

function RecordArt() {
  const { t } = useTranslation('common')
  const rows = [
    { label: t('Dining Out'), amount: '$12.50', dot: 'bg-rose-500' },
    { label: t('Transportation'), amount: '$3.25', dot: 'bg-cyan-500' },
  ]
  return (
    <div className="absolute inset-0 flex items-center justify-center px-4">
      <div className="flex w-64 max-w-full flex-col gap-2">
        <div className={cn(s.bubble, 'ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-sm')} style={delay(150)}>
          {t('onboarding.art.message')}
        </div>
        <div className="relative flex items-end gap-2">
          <Pocky className="h-8 w-8 shrink-0" />
          <div className={cn(s.typing, 'absolute bottom-1 left-10 flex gap-1 rounded-2xl rounded-bl-sm border bg-background px-3 py-2')}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={cn(s.typingDot, 'h-1.5 w-1.5 rounded-full bg-muted-foreground')} style={delay(i * 150)} />
            ))}
          </div>
          <div className={cn(s.bubble, 'flex-1 rounded-2xl rounded-bl-sm border bg-background/95 p-2 shadow-sm')} style={delay(1700)}>
            {rows.map((row) => (
              <div key={row.amount} className="mb-1.5 flex items-center gap-2 text-[11px]">
                <span className={cn('flex h-3 w-3 items-center justify-center rounded-[3px] text-white', s.leafBg)}>
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
                <span className={cn('h-1.5 w-1.5 rounded-full', row.dot)} />
                <span className="text-muted-foreground">{row.label}</span>
                <span className="ml-auto font-semibold tabular-nums">{row.amount}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <span className={cn(s.check, 'flex h-5 w-5 items-center justify-center rounded-full text-white', s.leafBg)}>
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              <span className={cn(s.press, 'inline-block rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground')}>
                {t('agent.tour.art.save')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AskArt() {
  const { t } = useTranslation('common')
  const bars = [38, 62, 30, 88]
  return (
    <div className="absolute inset-0 flex items-center justify-center px-4">
      <div className="flex w-64 max-w-full flex-col gap-2">
        <div className={cn(s.bubble, 'ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-sm')} style={delay(150)}>
          {t('agent.tour.art.question')}
        </div>
        <div className="flex items-end gap-2">
          <Pocky className="h-8 w-8 shrink-0" />
          <div className={cn(s.bubble, 'flex flex-1 items-end justify-between gap-3 rounded-2xl rounded-bl-sm border bg-background/95 px-3 py-2.5 shadow-sm')} style={delay(900)}>
            <div>
              <p className="text-lg font-semibold leading-none tabular-nums text-foreground">$302.20</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{t('agent.tour.art.answer')}</p>
            </div>
            <div className="flex h-10 items-end gap-1">
              {bars.map((height, i) => (
                <span
                  key={i}
                  className={cn(s.rise, 'w-2 rounded-sm', i === bars.length - 1 ? s.leafBg : 'bg-muted-foreground/30')}
                  style={{ height: `${height}%`, ...delay(1250 + i * 120) }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PlanArt() {
  const { t } = useTranslation('common')
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3 px-4">
      <div className={cn(s.guide, 'mb-6 shrink-0 self-end')} style={delay(100)}>
        <Pocky className="h-12 w-12" />
      </div>
      <div className="w-52 shrink-0 rounded-xl border bg-background/95 p-3 shadow-sm">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="font-semibold text-foreground">{t('onboarding.art.goal')}</span>
          <span className="tabular-nums text-muted-foreground">$3,000</span>
        </div>
        <svg viewBox="0 0 200 80" className="h-16 w-full overflow-visible" aria-hidden="true">
          <line x1="0" y1="10" x2="200" y2="10" strokeDasharray="4 4" strokeWidth="1.5" style={{ stroke: 'hsl(var(--muted-foreground) / 0.45)' }} />
          <path
            pathLength={1}
            d="M2 74 L40 66 L80 52 L120 38 L160 24 L196 11"
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={s.draw}
            style={{ stroke: 'var(--tour-leaf)' }}
          />
          <circle cx="196" cy="11" r="5" className={s.chip} style={{ fill: 'var(--tour-leaf)', transformBox: 'fill-box', transformOrigin: 'center', ...delay(1800) }} />
        </svg>
        <div className="mt-1 flex justify-end">
          <span className={cn(s.press, 'inline-block rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground')}>
            {t('onboarding.art.confirm')}
          </span>
        </div>
      </div>
    </div>
  )
}

function settingsArt(values: string[]) {
  return function SettingsArt() {
    return (
      <>
        <div className="absolute inset-x-0 top-5 flex flex-wrap justify-center gap-2 px-4">
          {values.map((value, i) => (
            <span
              key={value}
              className={cn(s.chip, 'relative rounded-full border bg-background/90 px-3 py-1 text-xs font-medium shadow-sm', s.ink)}
              style={delay(250 + i * 140)}
            >
              <span
                className={cn(s.chipGlow, 'absolute inset-0 rounded-full ring-2 ring-[color:var(--tour-leaf)]')}
                style={delay(1200 + i * 1500)}
              />
              {value}
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
}

function VoiceArt() {
  const levels = [10, 22, 30, 16, 26, 12, 20]
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-5 px-4">
      <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
        {[0, 1].map((i) => (
          <span key={i} className={cn(s.ripple, 'absolute inset-0 rounded-full border-2 border-[color:var(--tour-leaf)]')} style={delay(i * 1200)} />
        ))}
        <span className={cn('relative flex h-14 w-14 items-center justify-center rounded-full text-white shadow-md', s.leafBg)}>
          <Mic className="h-6 w-6" />
        </span>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex h-8 items-center gap-1">
          {levels.map((height, i) => (
            <span key={i} className={cn(s.wave, 'w-1.5 rounded-full', s.leafBg)} style={{ height, ...delay(i * 110) }} />
          ))}
        </div>
        {/* Dictation is English-only, so the transcript is English in every locale. */}
        <div className={cn(s.bubble, 'whitespace-nowrap rounded-lg border bg-background/95 px-3 py-2 text-xs text-foreground shadow-sm')} style={delay(1400)}>
          Lunch $12.50, bus $3.25
        </div>
      </div>
    </div>
  )
}

/**
 * Pocky's tour, in the dashboard tour's frame: recording, asking, planning, the
 * conversation settings and, where this browser can dictate, voice. It opens on
 * its own on the first visit to the page, and from "How it works" after that.
 */
export default function PockyTour({ open, onClose, onStart, enterSends, canDictate, settings }: PockyTourProps) {
  const { t } = useTranslation('common')
  const starting = useRef(false)
  const settingsKey = settings.join('\u0000')

  const steps = useMemo<TourStep[]>(() => [
    { id: 'record', Art: RecordArt, title: t('agent.tour.record.title'), body: t('agent.tour.record.body') },
    { id: 'ask', Art: AskArt, title: t('agent.tour.ask.title'), body: t('agent.tour.ask.body') },
    { id: 'plan', Art: PlanArt, title: t('agent.tour.plan.title'), body: t('agent.tour.plan.body') },
    { id: 'settings', Art: settingsArt(settingsKey.split('\u0000')), title: t('agent.tour.settings.title'), body: t('agent.contextHint') },
    ...(canDictate ? [{ id: 'voice', Art: VoiceArt, title: t('agent.tour.voice.title'), body: t('agent.tour.voice.body') }] : []),
  ], [t, canDictate, settingsKey])

  return (
    <TourDialog
      open={open}
      steps={steps}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        if (!starting.current) return
        starting.current = false
        event.preventDefault()
        onStart()
      }}
      finish={
        <div className="space-y-2">
          <Button className="w-full" onClick={() => { starting.current = true; onClose() }}>
            <PenLine />
            {t('agent.tour.start')}
          </Button>
          {enterSends && <p className="text-center text-xs text-muted-foreground">{t('agent.enterHint')}</p>}
        </div>
      }
    />
  )
}
