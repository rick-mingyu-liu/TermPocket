import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import { ArrowLeft } from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'
import { ThemeToggle } from '@/components/ui/theme-toggle'

type LegalDoc = 'privacy' | 'terms'

// The shape of each entry in public/locales/<locale>/legal.json. The text is
// long, so it lives in its own namespace rather than in common.json.
interface LegalSection {
  id?: string
  h: string
  p?: string[]
  items?: string[]
  after?: string[]
  links?: { label: string; href: string }[]
}

const TITLES: Record<LegalDoc, string> = { privacy: 'Privacy Policy', terms: 'Terms of Service' }

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

const LINK_CLASS = 'text-green-700 underline underline-offset-2 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300'

/** Supports HTTPS, local legal pages and section links; other text stays literal. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\[([^\]]+)\]\((https:\/\/[^\s)]+|\/(?:privacy|terms)(?:#[\w-]+)?|#[\w-]+)\)/)
  return <>{parts.map((part, i) => i % 3 === 1
    ? parts[i + 1].startsWith('https://')
      ? <a key={i} href={parts[i + 1]} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{part}</a>
      : <Link key={i} href={parts[i + 1]} className={LINK_CLASS}>{part}</Link>
    : i % 3 === 2 ? null : part)}</>
}

function Paragraphs({ text }: { text?: string[] }) {
  return <>{(text ?? []).map((para, i) => <p key={i} className="leading-relaxed text-muted-foreground"><Rich text={para} /></p>)}</>
}

/** Public, unauthenticated page for the privacy policy or the terms. */
export default function LegalPage({ doc }: { doc: LegalDoc }) {
  const { t } = useTranslation(['common', 'legal'])
  const router = useRouter()
  const other: LegalDoc = doc === 'privacy' ? 'terms' : 'privacy'
  const intro = list<string>(t(`legal:${doc}.intro`, { returnObjects: true }))
  const sections = list<LegalSection>(t(`legal:${doc}.sections`, { returnObjects: true }))
  const title = t(TITLES[doc])

  return (
    <>
      <Head>
        <title>{`${title} - TermPocket`}</title>
      </Head>
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b bg-card">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4">
            <Link href="/" aria-label={t('Back to TermPocket')} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
              <BrandLogo className="h-7" />
            </Link>
            <div className="flex items-center gap-2">
              <Link
                href={router.pathname}
                locale={router.locale === 'zh' ? 'en' : 'zh'}
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {router.locale === 'zh' ? 'English' : '中文'}
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl space-y-8 px-4 py-8 break-words">
          <div className="space-y-3">
            <h1 className="text-3xl font-bold text-green-700 dark:text-green-400">{title}</h1>
            <p className="inline-block rounded-md border border-yellow-400 bg-yellow-50 px-3 py-1 text-sm font-medium text-yellow-900 dark:border-yellow-500/60 dark:bg-yellow-900/20 dark:text-yellow-200">
              {t('Draft — last updated {{date}}', { date: t(`legal:updated`) })}
            </p>
            <div className="space-y-3"><Paragraphs text={intro} /></div>
          </div>

          {sections.map((section, i) => (
            <section key={i} id={section.id} className="space-y-3" aria-labelledby={`${doc}-${i}`}>
              <h2 id={`${doc}-${i}`} className="text-xl font-semibold">{section.h}</h2>
              <Paragraphs text={section.p} />
              {section.items && (
                <ul className="list-disc space-y-2 pl-5 leading-relaxed text-muted-foreground marker:text-green-600">
                  {section.items.map((item, j) => <li key={j}><Rich text={item} /></li>)}
                </ul>
              )}
              <Paragraphs text={section.after} />
              {section.links?.map(link => (
                <p key={link.href}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                    {link.label}
                  </a>
                </p>
              ))}
            </section>
          ))}

          <footer className="border-t pt-6 text-sm">
            <Link href={`/${other}`} className="text-green-700 underline underline-offset-2 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300">
              {t(TITLES[other])}
            </Link>
          </footer>
        </main>
      </div>
    </>
  )
}
