import { ComponentType, ReactNode, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { useTranslation } from 'next-i18next'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import s from './OnboardingTour.module.css'

export interface TourStep {
  id: string
  /** The animated picture above the text; remounted on every step so it replays. */
  Art: ComponentType
  title: string
  body: ReactNode
}

interface TourDialogProps {
  open: boolean
  steps: TourStep[]
  /** Called however the tour closes: Skip, Esc, the close button or a finish action. */
  onClose: () => void
  /** Shown on the last step in place of Next; its first button takes focus there. */
  finish: ReactNode
  onCloseAutoFocus?: (event: Event) => void
}

/** The app icon, light and dark, switched by Tailwind's `dark` class like BrandLogo. */
export function TourPocky({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-block', className)}>
      <Image src="/brand/termpocket-icon.svg" alt="" width={100} height={100} className="h-full w-full dark:hidden" />
      <Image src="/brand/termpocket-icon-dark.svg" alt="" width={100} height={100} className="hidden h-full w-full dark:block" />
    </span>
  )
}

export const tourDelay = (ms: number) => ({ animationDelay: `${ms}ms` })

/**
 * The frame both tours share (the dashboard's first-run tour and Pocky's):
 * an illustrated stage, step dots, the step's title and text, and Skip / Back /
 * Next, with the caller's actions on the last step. Steps are tracked by id, so
 * a step added while the tour is open never moves the one on screen.
 */
export default function TourDialog({ open, steps, onClose, finish, onCloseAutoFocus }: TourDialogProps) {
  const { t } = useTranslation('common')
  const firstId = steps[0]?.id
  const [stepId, setStepId] = useState(firstId)
  const contentRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const finishRef = useRef<HTMLDivElement>(null)

  // Every opening starts at the first step. Reset while rendering the opening
  // (not in an effect), so a reopened tour never shows, or focuses, the step
  // it was closed on for a frame.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setStepId(firstId)
  }
  const focusFirst = () => (nextRef.current ?? finishRef.current?.querySelector<HTMLElement>('button, a[href]'))?.focus()

  const index = Math.max(steps.findIndex((step) => step.id === stepId), 0)
  const step = steps[index]
  const last = index === steps.length - 1

  // When the button that had focus disappears (Back on the first step, Next on
  // the last), keep focus inside the dialog on the obvious next control.
  useEffect(() => {
    if (!open) return
    const id = window.requestAnimationFrame(() => {
      const content = contentRef.current
      const active = document.activeElement
      // Radix parks focus on the content itself when the focused button goes.
      if (content && active && active !== content && content.contains(active)) return
      if (last) finishRef.current?.querySelector<HTMLElement>('button, a[href]')?.focus()
      else nextRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [open, stepId, last])

  if (!step) return null
  const { Art } = step

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusFirst()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-[calc(100%-2rem)] max-w-md gap-0 overflow-hidden rounded-2xl p-0 max-h-[calc(100dvh-2rem)] overflow-y-auto motion-reduce:animate-none sm:rounded-2xl"
      >
        <div className={s.stage} aria-hidden="true">
          <Art key={step.id} />
        </div>

        <div className="px-5 pb-5 pt-4 sm:px-6">
          <div className="mb-3 flex items-center gap-1.5" role="group" aria-label={t('onboarding.progress', { current: index + 1, total: steps.length })}>
            {steps.map(({ id }, i) => (
              <button
                key={id}
                type="button"
                onClick={() => setStepId(id)}
                aria-label={t('onboarding.goTo', { n: i + 1 })}
                aria-current={i === index ? 'step' : undefined}
                className={cn(
                  s.dot,
                  'h-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  i === index ? 'w-6 bg-[#1e7a4e] dark:bg-[#87e09e]' : 'w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                )}
              />
            ))}
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {t('onboarding.progress', { current: index + 1, total: steps.length })}
            </span>
          </div>

          <div key={step.id} className={cn(s.fadeUp, !last && 'min-h-[6.5rem]')} aria-live="polite">
            <DialogTitle className="text-xl font-semibold leading-tight tracking-tight">{step.title}</DialogTitle>
            <DialogDescription className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</DialogDescription>
          </div>

          {last && <div ref={finishRef} className="mt-4">{finish}</div>}

          <div className="mt-5 flex items-center gap-2">
            {!last && (
              <Button variant="ghost" size="sm" className="-ml-3 text-muted-foreground" onClick={onClose}>
                {t('onboarding.skip')}
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              {index > 0 && (
                <Button variant="outline" size="sm" onClick={() => setStepId(steps[index - 1]!.id)}>
                  <ArrowLeft />
                  {t('onboarding.back')}
                </Button>
              )}
              {!last && (
                <Button ref={nextRef} size="sm" onClick={() => setStepId(steps[index + 1]!.id)}>
                  {t('onboarding.next')}
                  <ArrowRight />
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
