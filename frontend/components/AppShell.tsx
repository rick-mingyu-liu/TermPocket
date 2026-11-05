import type { ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import {
  ArrowLeftRight,
  LayoutDashboard,
  MessageSquare,
  Plus,
  ScanText,
  Settings,
  Target,
  type LucideIcon,
} from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { cn } from '@/lib/utils'

/**
 * The signed-in pages' shared navigation, so no page needs its own
 * "Back to Dashboard" button to be reachable.
 *
 * At lg and wider the sections are a tab strip in the top bar, styled like the
 * app's other tabs. Below lg they move to a bottom tab bar, with Add
 * transaction as its middle button (it replaces the old floating button);
 * Import keeps an icon in the top bar there.
 *
 * Pages keep their own title band and layout; the shell only adds the bars.
 */

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  match: (path: string) => boolean
}

const NAV: NavItem[] = [
  { href: '/', label: 'nav.overview', icon: LayoutDashboard, match: (p) => p === '/' },
  { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight, match: (p) => p.startsWith('/transactions') && p !== '/transactions/new' },
  { href: '/goals', label: 'nav.goals', icon: Target, match: (p) => p.startsWith('/goals') },
  { href: '/agent', label: 'nav.pocky', icon: MessageSquare, match: (p) => p.startsWith('/agent') },
  { href: '/import', label: 'nav.import', icon: ScanText, match: (p) => p.startsWith('/import') },
]

// The phone's tab bar: four sections around the add button.
const TAB_BAR = ['/', '/transactions', null, '/goals', '/agent'] as const

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const { t } = useTranslation('common')
  const path = router.pathname
  const onSettings = path.startsWith('/settings')

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="shrink-0 rounded-md" aria-label="TermPocket">
            <BrandLogo className="h-8" priority />
          </Link>

          <nav aria-label={t('nav.main')} className="hidden lg:block">
            <ul className="flex h-10 items-center rounded-lg bg-muted p-1 text-muted-foreground">
              {NAV.map((item) => {
                const active = item.match(path)
                const Icon = item.icon
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors hover:text-foreground',
                        active && 'bg-background text-foreground shadow',
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {t(item.label)}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button asChild className="hidden lg:inline-flex">
              <Link href="/transactions/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('Add Transaction')}
              </Link>
            </Button>
            <Button asChild variant="outline" size="icon" className="lg:hidden">
              <Link href="/import" aria-label={t('Import from screenshot')} aria-current={path.startsWith('/import') ? 'page' : undefined}>
                <ScanText aria-hidden="true" />
              </Link>
            </Button>
            <ThemeToggle />
            <Button asChild variant="outline" size="icon" className={cn(onSettings && 'bg-accent')}>
              <Link href="/settings" aria-label={t('Settings')} aria-current={onSettings ? 'page' : undefined}>
                <Settings aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</div>

      <nav
        aria-label={t('nav.main')}
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="mx-auto grid h-16 max-w-md grid-cols-5 items-center px-2">
          {TAB_BAR.map((href) => {
            if (href === null) {
              return (
                <li key="add" className="flex justify-center">
                  <Link
                    href="/transactions/new"
                    aria-label={t('Add Transaction')}
                    aria-current={path === '/transactions/new' ? 'page' : undefined}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-95"
                  >
                    <Plus className="h-6 w-6" aria-hidden="true" />
                  </Link>
                </li>
              )
            }
            const item = NAV.find((n) => n.href === href)!
            const active = item.match(path)
            const Icon = item.icon
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                    active && 'text-foreground',
                  )}
                >
                  <Icon className={cn('h-5 w-5', active && 'stroke-[2.25]')} aria-hidden="true" />
                  {t(item.label)}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
