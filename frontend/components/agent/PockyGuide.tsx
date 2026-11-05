import { useTranslation } from 'next-i18next'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

/**
 * The how-to for the Pocky page, kept out of the way: what to type, how saving
 * works, what the conversation settings do, dictation and the keyboard. The page
 * itself shows only the composer, a few example prompts and the privacy line.
 */
export default function PockyGuide({ enterSends, canDictate }: { enterSends: boolean; canDictate: boolean }) {
  const { t } = useTranslation('common')
  const sections: { title: string; body: string[] }[] = [
    { title: t('agent.guide.recordTitle'), body: [t('agent.guide.record'), t('agent.example'), t('agent.reviewHint')] },
    { title: t('agent.guide.askTitle'), body: [t('agent.guide.ask'), t('agent.exampleQuestion')] },
    { title: t('agent.guide.planTitle'), body: [t('agent.guide.plan'), t('agent.examplePlan')] },
    { title: t('agent.guide.settingsTitle'), body: [t('agent.contextHint')] },
    ...(canDictate ? [{ title: t('agent.guide.voiceTitle'), body: [t('agent.guide.voice')] }] : []),
    ...(enterSends ? [{ title: t('agent.guide.keysTitle'), body: [t('agent.enterHint')] }] : []),
  ]
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0" aria-label={t('agent.guide.open')}><BookOpen /><span className="hidden sm:inline">{t('agent.guide.open')}</span></Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('agent.guide.title')}</DialogTitle>
          <DialogDescription>{t('agent.subtitle')}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-4">
          {sections.map(({ title, body }) => (
            <div key={title} className="border-t pt-3">
              <dt className="text-sm font-medium">{title}</dt>
              {body.map((line) => <dd key={line} className="mt-1 text-sm leading-relaxed text-muted-foreground">{line}</dd>)}
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
