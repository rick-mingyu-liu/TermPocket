import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import {
  ArrowLeft,
  Trash2,
  AlertTriangle,
  Palette,
  Bell,
  User,
  Moon,
  Sun,
  Monitor,
  LogOut,
  BookOpen,
  History,
  PlayCircle,
  UserX,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { api, accountAPI, logout, retentionAPI, RetentionSetting, RetentionWindow } from '@/utils/api'
import { formatDay } from '@/lib/date'
import { agentAPI, agentUnavailable } from '@/utils/agentApi'
import { useTheme } from '@/contexts/ThemeContext'
import AiConnections from '@/components/AiConnections'
import PockyMemory from '@/components/PockyMemory'
import OpenSourceAcknowledgements from '@/components/OpenSourceAcknowledgements'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog'
import Swal from 'sweetalert2'
import { useTranslation } from 'next-i18next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import {
  LanguagePreference,
  UserPreferences,
  readPreferences,
  resolveLanguage,
  savePreferences,
} from '@/lib/preferences'

const THEMES = [
  { value: 'light', icon: Sun, label: 'Light', hint: 'Clean and bright interface' },
  { value: 'dark', icon: Moon, label: 'Dark', hint: 'Easy on the eyes' },
  { value: 'system', icon: Monitor, label: 'System', hint: 'Follows your device' },
] as const

/**
 * Every control here takes effect and is kept the moment it changes — there
 * is no Save button to forget. Currency and language
 * live in this browser; the weekly report switch and automatic deletion are
 * stored on the server. Turning automatic deletion on is the one change that
 * asks first, because it permanently deletes transactions.
 */

const SEASONS: Record<string, string> = { winter: 'Winter', spring: 'Spring', fall: 'Fall' }
export default function Settings() {
  const router = useRouter()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const { t, i18n } = useTranslation('common')
  const [preferences, setPreferences] = useState<UserPreferences>({ currency: 'CAD', language: 'system' })
  // null until the server says; the switch is disabled rather than guessing.
  const [weeklyReports, setWeeklyReports] = useState<boolean | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [ackDialogOpen, setAckDialogOpen] = useState(false)
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [accountPassword, setAccountPassword] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)
  // Shown inside the dialog: wrong password, demo account, rate limit.
  const [accountError, setAccountError] = useState<string | null>(null)
  // null until the server says, like the weekly report switch.
  const [retention, setRetention] = useState<RetentionSetting | null>(null)
  const [retentionBusy, setRetentionBusy] = useState(false)
  // What turning it on would delete now, shown before anything is stored.
  const [retentionPreview, setRetentionPreview] = useState<(RetentionWindow & { count: number }) | null>(null)

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      router.push('/login')
      return
    }
    setPreferences(readPreferences())

    api.get('/auth/profile')
      .then(({ data }) => {
        const { weekly_reports_enabled: weekly, email_notifications_enabled: email } = data.user
        setWeeklyReports(Boolean(weekly && email))
      })
      .catch(() => toast.error(t('Could not load your notification setting.')))

    retentionAPI.get()
      .then(({ data }) => setRetention(data))
      .catch(() => toast.error(t('retention.loadError')))
  }, [router, t])

  // '2024-fall' -> 'Fall 2024' / '2024年秋季', the way the dashboard names a term.
  const termName = (termId: string) => {
    const [year, season] = termId.split('-')
    return t('{{season}} {{year}}', { season: t(SEASONS[season] ?? season), year })
  }

  const storeRetention = async (terms: number | null) => {
    setRetentionBusy(true)
    try {
      const { data } = await retentionAPI.set(terms)
      setRetention(data)
      setRetentionPreview(null)
      saved()
    } catch {
      toast.error(t('Could not save. Please try again.'))
    } finally {
      setRetentionBusy(false)
    }
  }

  // Off is stored at once. Any window first shows what it would delete now
  // and is stored only from the confirmation dialog.
  const changeRetention = async (value: string) => {
    if (retentionBusy) return
    if (value === 'off') {
      await storeRetention(null)
      return
    }
    setRetentionBusy(true)
    try {
      const { data } = await retentionAPI.preview(Number(value))
      setRetentionPreview(data)
    } catch {
      toast.error(t('retention.previewError'))
    } finally {
      setRetentionBusy(false)
    }
  }

  const saved = () => toast.success(t('Saved'), { id: 'settings-saved' })

  const changeCurrency = (currency: string) => {
    setPreferences(savePreferences({ currency }))
    saved()
  }

  const changeLanguage = (value: string) => {
    const language = value as LanguagePreference
    setPreferences(savePreferences({ language }))
    const locale = resolveLanguage(language)
    i18n.changeLanguage(locale)
    router.push(router.asPath, router.asPath, { locale })
  }

  const changeWeeklyReports = async (checked: boolean) => {
    setWeeklyReports(checked)
    try {
      // The scheduler sends only when both flags are on; this switch is both.
      await api.put('/auth/notifications', {
        weekly_reports_enabled: checked,
        email_notifications_enabled: checked,
      })
      saved()
    } catch {
      setWeeklyReports(!checked)
      toast.error(t('Could not save. Please try again.'))
    }
  }

  const handleClearData = async () => {
    if (clearing || deleteConfirmation !== 'DELETE') return
    setClearing(true)
    try {
      // Remove confirmation sources before deleting financial rows, so an
      // existing draft cannot commit after the transaction deletion finishes.
      // A deployment with the feature disabled has no agent history to clear,
      // and may not have its migration. If the check itself fails, attempt the
      // deletion anyway so a real partial failure is still reported.
      const agentEnabled = await agentAPI.status().then(status => status.storage, () => true)
      // Forget all first: it also stops any running Pocky reply, so none can
      // offer a fact from the history about to be deleted. Before the memory
      // migration there is nothing to forget, which is not a failure.
      if (agentEnabled) await agentAPI.forgetAllMemories().catch(error => { if (!agentUnavailable(error)) throw error })
      const agentCleared = !agentEnabled ? null : await agentAPI.clear().then(() => true).catch(error => {
        // Clear existing app data, but never claim its agent history cleared.
        if (agentUnavailable(error)) return false
        throw error
      })
      await Promise.all([
        api.delete('/transactions/clear-all'),
        api.delete('/goals/clear-all'),
      ])
      setClearDialogOpen(false)
      await Swal.fire({
        icon: agentCleared === false ? 'info' : 'success',
        title: t(agentCleared === false ? 'agent.clearPartialTitle' : 'All data cleared'),
        text: t(agentCleared === null ? 'agent.clearSuccessWithoutAgent' : agentCleared ? 'agent.clearSuccess' : 'agent.clearPartialUnavailable'),
        confirmButtonText: t('OK'),
      })
      router.push('/')
    } catch (error) {
      const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code
      if (code === 'clear_demo') {
        setClearDialogOpen(false)
        toast.error(t('agent.clearDemoRefused'))
      } else {
        toast.error(t('Could not clear all data. Some of it may already be deleted; please try again.'))
      }
    } finally {
      setClearing(false)
    }
  }

  const openAccountDialog = (open: boolean) => {
    if (deletingAccount) return
    setAccountDialogOpen(open)
    setAccountPassword('')
    setAccountError(null)
  }

  const handleDeleteAccount = async () => {
    if (deletingAccount || !accountPassword) return
    setDeletingAccount(true)
    setAccountError(null)
    try {
      await accountAPI.delete(accountPassword)
      setAccountPassword('')
      toast.success(t('deleteAccount.done'))
      // Clears the stored login and goes to the login page.
      logout()
    } catch (error) {
      const response = (error as { response?: { status?: number, data?: { code?: string } } }).response
      const code = response?.data?.code
      setAccountError(t(
        code === 'account_password_incorrect' ? 'deleteAccount.wrongPassword'
          : code === 'account_demo' ? 'deleteAccount.demoRefused'
            : response?.status === 429 ? 'deleteAccount.rateLimited'
              : 'deleteAccount.error'
      ))
      setDeletingAccount(false)
    }
  }

  return (
    <>
      <Head>
        <title>Settings - TermPocket</title>
        <meta name="description" content="Manage your app settings and preferences" />
      </Head>

      <div className="min-h-screen bg-background">
        <div className="border-b bg-card">
          <div className="container mx-auto px-4 py-6">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/')}
                className="flex items-center"
                aria-label={t('Back to Dashboard')}
              >
                <ArrowLeft className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">{t('Back to Dashboard')}</span>
              </Button>
              <div>
                <h1 className="text-3xl font-bold">{t('Settings')}</h1>
                <p className="text-muted-foreground">
                  {t('Changes are saved as you make them.')}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="container mx-auto px-4 py-8">
          <div className="max-w-4xl mx-auto space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Palette className="h-5 w-5" />
                  {t('Appearance')}
                </CardTitle>
                <CardDescription>
                  {t('Customize the look and feel of your app')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Label className="text-base">{t('Theme')}</Label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4" role="radiogroup" aria-label={t('Theme')}>
                  {THEMES.map(({ value, icon: Icon, label, hint }) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={theme === value}
                      onClick={() => setTheme(value)}
                      className={`p-4 border rounded-lg text-left transition-colors ${
                        theme === value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <div className="flex items-center space-x-3">
                        <Icon className="h-5 w-5" />
                        <div>
                          <p className="font-medium">{t(label)}</p>
                          <p className="text-sm text-muted-foreground">{t(hint)}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                {theme === 'system' && (
                  <p className="text-sm text-muted-foreground">
                    {t('Current theme')}: <span className="font-medium">{t(resolvedTheme === 'dark' ? 'Dark' : 'Light')}</span>
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  {t('Preferences')}
                </CardTitle>
                <CardDescription>
                  {t('Customize your app experience')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label htmlFor="currency">{t('Currency')}</Label>
                    <Select value={preferences.currency} onValueChange={changeCurrency}>
                      <SelectTrigger id="currency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CAD">CAD ($)</SelectItem>
                        <SelectItem value="USD">USD ($)</SelectItem>
                        <SelectItem value="CNY">CNY (¥)</SelectItem>
                        <SelectItem value="EUR">EUR (€)</SelectItem>
                        <SelectItem value="GBP">GBP (£)</SelectItem>
                        <SelectItem value="AUD">AUD (A$)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      {t('Totals on the dashboard and transactions page are converted to this currency.')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="language">{t('Language')}</Label>
                    <Select value={preferences.language} onValueChange={changeLanguage}>
                      <SelectTrigger id="language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">{t('System')}</SelectItem>
                        <SelectItem value="en">{t('English')}</SelectItem>
                        <SelectItem value="zh">{t('Mandarin')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="mt-6 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-0.5">
                    <p className="text-base font-medium leading-none">{t('onboarding.settings.title')}</p>
                    <p className="text-sm text-muted-foreground">{t('onboarding.settings.hint')}</p>
                  </div>
                  <Button variant="outline" className="shrink-0" onClick={() => router.push('/?tour=1')}>
                    <PlayCircle className="h-4 w-4" />
                    {t('onboarding.settings.replay')}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5" />
                  {t('Notifications')}
                </CardTitle>
                <CardDescription>
                  {t('Manage your notification preferences')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="weekly-reports" className="text-base">{t('Weekly Reports')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('Get weekly financial summary by email every Sunday at 7 p.m.')}
                    </p>
                  </div>
                  <Switch
                    id="weekly-reports"
                    checked={weeklyReports ?? false}
                    disabled={weeklyReports === null}
                    onCheckedChange={changeWeeklyReports}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <History className="h-5 w-5" />
                  {t('retention.heading')}
                </CardTitle>
                <CardDescription>
                  {t('retention.summary')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 md:max-w-sm">
                  <Label htmlFor="retention">{t('retention.label')}</Label>
                  <Select
                    value={retention?.retentionTerms ? String(retention.retentionTerms) : 'off'}
                    onValueChange={changeRetention}
                    disabled={!retention || !retention.available || retentionBusy || (retention.demo && retention.retentionTerms === null)}
                  >
                    <SelectTrigger id="retention">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">{t('retention.off')}</SelectItem>
                      {(retention?.choices ?? []).map((terms) => (
                        <SelectItem key={terms} value={String(terms)}>{t(`retention.keep${terms}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-sm text-muted-foreground">
                  {!retention ? null
                    : !retention.available ? t('retention.notAvailable')
                      : retention.demo ? t('retention.demo')
                        : retention.window
                          ? t('retention.onHint', { date: formatDay(retention.window.cutoff, i18n.language), term: termName(retention.window.keepFromTerm) })
                          : t('retention.offHint')}
                </p>
                <p className="text-sm text-muted-foreground">{t('retention.scope')}</p>
              </CardContent>
            </Card>

            <PockyMemory />

            <AiConnections />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  {t('Account Management')}
                </CardTitle>
                <CardDescription>
                  {t('Manage your account and data')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label className="text-base">{t('Sign Out')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('Sign out of your account')}
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => logout()}>
                    <LogOut className="w-4 h-4 mr-2" />
                    {t('Logout')}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              <Link href="/terms" className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{t('Terms of Service')}</Link>
              <Link href="/privacy" className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{t('Privacy Policy')}</Link>
              <Button variant="ghost" onClick={() => setAckDialogOpen(true)} className="flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                {t('Open Source Acknowledgements')}
              </Button>
            </div>

            <details className="rounded-lg border border-destructive/40 bg-card">
              <summary className="flex cursor-pointer items-center gap-2 rounded-lg p-6 font-semibold text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <AlertTriangle className="h-5 w-5" />
                {t('Danger zone')}
              </summary>
              <div className="space-y-4 px-6 pb-6">
                <p className="text-sm text-muted-foreground">
                  {t('agent.clearDescription')}
                </p>
                <Button variant="destructive" onClick={() => { setDeleteConfirmation(''); setClearDialogOpen(true) }} disabled={clearing}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('Clear All Data')}
                </Button>
                <div className="space-y-4 border-t border-destructive/20 pt-4">
                  <div className="space-y-1">
                    <p className="font-medium">{t('deleteAccount.deleteHeading')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('deleteAccount.deleteSummary')}
                    </p>
                  </div>
                  <Button variant="destructive" onClick={() => openAccountDialog(true)} disabled={deletingAccount}>
                    <UserX className="mr-2 h-4 w-4" />
                    {t('deleteAccount.button')}
                  </Button>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>

      <Dialog open={clearDialogOpen} onOpenChange={(open) => { if (!clearing) { setClearDialogOpen(open); setDeleteConfirmation('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Clear All Data')}</DialogTitle>
            <DialogDescription>
              {t('agent.clearWarning')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirmation">{t('Type DELETE to confirm')}</Label>
            <Input id="delete-confirmation" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={clearing} />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={clearing}>{t('Cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleClearData} disabled={clearing || deleteConfirmation !== 'DELETE'}>
              {clearing ? t('Clearing...') : t('Yes, Delete Everything')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={accountDialogOpen} onOpenChange={openAccountDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('deleteAccount.deleteTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('deleteAccount.body')}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{t('deleteAccount.item1')}</li>
            <li>{t('deleteAccount.item2')}</li>
            <li>{t('deleteAccount.item3')}</li>
            <li>{t('deleteAccount.item4')}</li>
          </ul>
          <p className="text-sm text-muted-foreground">{t('deleteAccount.note')}</p>
          <form
            className="space-y-2"
            onSubmit={(event) => { event.preventDefault(); handleDeleteAccount() }}
          >
            <Label htmlFor="delete-account-password">{t('deleteAccount.passwordLabel')}</Label>
            <Input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              value={accountPassword}
              onChange={(event) => { setAccountPassword(event.target.value); setAccountError(null) }}
              disabled={deletingAccount}
              aria-invalid={accountError !== null}
              aria-describedby={accountError ? 'delete-account-error' : undefined}
            />
            {accountError && (
              <p id="delete-account-error" role="alert" className="text-sm font-medium text-destructive">{accountError}</p>
            )}
          </form>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deletingAccount}>{t('Cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleDeleteAccount} disabled={deletingAccount || !accountPassword}>
              {deletingAccount ? t('deleteAccount.deleting') : t('deleteAccount.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={retentionPreview !== null} onOpenChange={(open) => { if (!open && !retentionBusy) setRetentionPreview(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('retention.confirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {retentionPreview && t('retention.confirmBody', {
                terms: retentionPreview.terms,
                date: formatDay(retentionPreview.cutoff, i18n.language),
                term: termName(retentionPreview.keepFromTerm),
              })}
            </DialogDescription>
          </DialogHeader>
          {retentionPreview && (
            <div className="space-y-2 text-sm">
              <p className="font-medium">{t('retention.confirmCount', { count: retentionPreview.count })}</p>
              <p className="text-muted-foreground">{t('retention.scope')}</p>
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={retentionBusy}>{t('Cancel')}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={retentionBusy || !retentionPreview}
              onClick={() => { if (retentionPreview) storeRetention(retentionPreview.terms) }}
            >
              {t('retention.confirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OpenSourceAcknowledgements open={ackDialogOpen} onOpenChange={setAckDialogOpen} />
    </>
  )
}

export async function getStaticProps({ locale }: { locale: string }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
}
