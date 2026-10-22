import { useTranslation } from 'next-i18next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import ocrProfile from '@/lib/ocr/profile.json'
import { cn } from '@/lib/utils'

interface OpenSourceAcknowledgementsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

type Project = readonly [name: string, url: string]

const frontendProjects: Project[] = [
  ['Next.js', 'https://nextjs.org'],
  ['React', 'https://react.dev'],
  ['TypeScript', 'https://www.typescriptlang.org'],
  ['Tailwind CSS', 'https://tailwindcss.com'],
  ['shadcn/ui', 'https://ui.shadcn.com'],
  ['Radix UI', 'https://www.radix-ui.com/primitives'],
  ['Lucide', 'https://lucide.dev'],
  ['Recharts', 'https://github.com/recharts/recharts'],
  ['React Hook Form', 'https://react-hook-form.com'],
  ['i18next', 'https://www.i18next.com'],
  ['next-i18next', 'https://github.com/i18next/next-i18next'],
  ['react-i18next', 'https://github.com/i18next/react-i18next'],
  ['SweetAlert2', 'https://sweetalert2.github.io'],
  ['react-hot-toast', 'https://github.com/timolins/react-hot-toast'],
  ['react-markdown', 'https://github.com/remarkjs/react-markdown'],
  ['Axios', 'https://axios-http.com'],
  ['clsx', 'https://github.com/lukeed/clsx'],
  ['Class Variance Authority', 'https://github.com/joe-bell/cva'],
  ['PostCSS', 'https://postcss.org'],
  ['Autoprefixer', 'https://github.com/postcss/autoprefixer'],
  ['tailwind-merge', 'https://github.com/dcastil/tailwind-merge'],
  ['tailwindcss-animate', 'https://github.com/jamiebuilds/tailwindcss-animate'],
  ['Vercel Analytics SDK', 'https://github.com/vercel/analytics']
]

const backendProjects: Project[] = [
  ['Node.js', 'https://nodejs.org'],
  ['Express', 'https://expressjs.com'],
  ['PostgreSQL', 'https://www.postgresql.org'],
  ['node-postgres', 'https://github.com/brianc/node-postgres'],
  ['bcrypt.js', 'https://github.com/dcodeIO/bcrypt.js'],
  ['Helmet', 'https://helmetjs.github.io'],
  ['express-rate-limit', 'https://github.com/express-rate-limit/express-rate-limit'],
  ['express-validator', 'https://express-validator.github.io'],
  ['cors', 'https://github.com/expressjs/cors'],
  ['jsonwebtoken', 'https://github.com/auth0/node-jsonwebtoken'],
  ['Nodemailer', 'https://nodemailer.com'],
  ['node-cron', 'https://nodecron.com'],
  ['dotenv', 'https://github.com/motdotla/dotenv'],
  ['Morgan', 'https://github.com/expressjs/morgan']
]

const ocrProjects: Project[] = [
  ['ppu-paddle-ocr', 'https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr'],
  ['ONNX Runtime', 'https://github.com/microsoft/onnxruntime'],
  ['PaddleOCR', 'https://github.com/PaddlePaddle/PaddleOCR'],
  [ocrProfile.name, 'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/tree/bf1d5edb0335d3262be7caf13f766ba274b4cadd']
]

// Pinned by scripts/voice-assets.js; the model link names the exact commit shipped.
const voiceProjects: Project[] = [
  ['Transformers.js', 'https://github.com/huggingface/transformers.js'],
  ['ONNX Runtime', 'https://github.com/microsoft/onnxruntime'],
  ['Whisper', 'https://github.com/openai/whisper'],
  ['whisper-base.en (ONNX)', 'https://huggingface.co/onnx-community/whisper-base.en/tree/51eefc0af78b103839eda9e7e4f4186acc6517fe']
]

function ProjectLinks({ projects }: { projects: Project[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {projects.map(([name, url]) => (
        <li key={name}>
          <a href={url} target="_blank" rel="noopener noreferrer" className="rounded-sm underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {name}
          </a>
        </li>
      ))}
    </ul>
  )
}

export default function OpenSourceAcknowledgements({ open, onOpenChange, className }: OpenSourceAcknowledgementsProps) {
  const { t } = useTranslation('common')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('max-h-[80vh] max-w-2xl overflow-y-auto', className)}>
        <DialogHeader>
          <DialogTitle>{t('Open Source Acknowledgements')}</DialogTitle>
          <DialogDescription>{t('agent.acknowledgementsIntro')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="font-semibold">{t('Frontend')}</h3>
            <ProjectLinks projects={frontendProjects} />
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t('Backend')}</h3>
            <ProjectLinks projects={backendProjects} />
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t('Browser OCR')}</h3>
            <p className="text-sm text-muted-foreground">{t('Screenshot recognition runs in your browser with ppu-paddle-ocr and ONNX Runtime, using PaddleOCR models converted for ppu-paddle-ocr and published on Hugging Face (snowfluke/ppu-paddle-ocr-models). The model link identifies the exact version TermPocket ships.')}</p>
            <ProjectLinks projects={ocrProjects} />
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t('agent.voice.ackTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('agent.voice.ackText')}</p>
            <ProjectLinks projects={voiceProjects} />
          </section>
          <section className="space-y-3 border-t pt-4">
            <h3 className="font-semibold">{t('agent.additionalSoftware')}</h3>
            <ProjectLinks projects={[
              ['Anthropic TypeScript SDK — Anthropic (MIT)', 'https://github.com/anthropics/anthropic-sdk-typescript'],
            ]} />
            <p className="text-sm text-muted-foreground">{t('agent.sdkAcknowledgement')}</p>
          </section>
          <section className="space-y-3 border-t pt-4">
            <h3 className="font-semibold">{t('External services')}</h3>
            <p className="text-sm text-muted-foreground">{t('These API services are listed separately from the open source libraries above.')}</p>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/privacy#ai-providers" className="rounded-sm underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t('agent.aiProviders')}
                </Link>
                <p className="mt-1 text-muted-foreground">{t('agent.providerAcknowledgement')}</p>
              </li>
              <li><ProjectLinks projects={[
                ['Frankfurter', 'https://frankfurter.dev']
              ]} /><p className="mt-1 text-muted-foreground">{t('Currency exchange rates')}</p></li>
              <li><ProjectLinks projects={[
                ['MailboxLayer', 'https://mailboxlayer.com']
              ]} /><p className="mt-1 text-muted-foreground">{t('Email address validation when configured')}</p></li>
            </ul>
          </section>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t('Close')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
