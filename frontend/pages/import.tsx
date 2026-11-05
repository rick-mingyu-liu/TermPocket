import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'
import toast from 'react-hot-toast'
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Upload, X } from 'lucide-react'
import axios from 'axios'
import { api } from '@/utils/api'
import { todayDay } from '@/lib/date'
import { useOcr } from '@/lib/ocr/useOcr'
import {
  toImportPayload, toReviewRows, totalsByCurrency,
  type ParseResponse, type ReviewRow,
} from '@/lib/import/review'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropZone, MAX_FILES_PER_BATCH } from '@/components/import/DropZone'
import { ReviewTable } from '@/components/import/ReviewTable'
import { SourcePreview } from '@/components/import/SourcePreview'

type ShotStatus = 'queued' | 'reading' | 'parsing' | 'done' | 'failed'

interface Shot {
  id: number
  file: File
  url: string
  status: ShotStatus
  error?: string
  image?: { width: number; height: number }
  durationMs?: number
  layout?: ParseResponse['layout']
  warnings: string[]
  unparsedLines: string[]
}

const LAYOUT_LABEL: Record<ParseResponse['layout'], string> = {
  'bank-list': 'Bank list',
  receipt: 'Receipt',
  'uber-activity': 'Uber trips',
  'uber-eats-orders': 'Uber Eats orders',
  'wechat-pay': 'WeChat Pay',
  unknown: 'Unrecognised layout',
}

const STATUS_LABEL: Record<ShotStatus, string> = {
  queued: 'Queued',
  reading: 'Reading',
  parsing: 'Parsing',
  done: 'Done',
  failed: 'Failed',
}

export default function ImportPage() {
  const router = useRouter()
  const { t } = useTranslation('common')
  const { state: engine, recognize, retry } = useOcr()

  const [shots, setShots] = useState<Shot[]>([])
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const nextShotId = useRef(1)
  const shotsRef = useRef<Shot[]>([])
  shotsRef.current = shots

  useEffect(() => {
    if (!localStorage.getItem('token')) router.replace('/login')
  }, [router])

  // Object URLs hold the screenshots in memory; release them with the page.
  useEffect(() => () => shotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.url)), [])

  const updateShot = (id: number, patch: Partial<Shot>) =>
    setShots((current) => current.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)))

  const process = useCallback(async (shot: Shot) => {
    updateShot(shot.id, { status: 'reading', error: undefined })
    try {
      const ocr = await recognize(shot.file)
      updateShot(shot.id, { status: 'parsing', image: ocr.image, durationMs: ocr.durationMs })
      const { data } = await api.post<ParseResponse>('/import/parse', {
        today: todayDay(),
        model: ocr.model,
        image: ocr.image,
        lines: ocr.lines,
      })
      setRows((current) => [...current, ...toReviewRows(shot.id, data.rows, current)])
      updateShot(shot.id, {
        status: 'done',
        layout: data.layout,
        warnings: data.warnings,
        unparsedLines: data.unparsedLines,
      })
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error ?? t('The screenshot could not be read.')
        : (error as Error).message
      updateShot(shot.id, { status: 'failed', error: message })
    }
  }, [recognize, t])

  const addFiles = (files: File[]) => {
    const accepted = files.slice(0, MAX_FILES_PER_BATCH)
    if (files.length > accepted.length) toast.error(t('Too many images: only the first 5 were added.'))
    const added = accepted.map((file) => ({
      id: nextShotId.current++,
      file,
      url: URL.createObjectURL(file),
      status: 'queued' as const,
      warnings: [],
      unparsedLines: [],
    }))
    setShots((current) => [...current, ...added])
    // recognize() runs one image at a time, so these queue behind each other.
    added.forEach((shot) => { void process(shot) })
  }

  const removeShot = (id: number) => {
    const shot = shots.find((s) => s.id === id)
    if (shot) URL.revokeObjectURL(shot.url)
    setShots((current) => current.filter((s) => s.id !== id))
    setRows((current) => current.filter((row) => row.shotId !== id))
  }

  const changeRow = (key: string, patch: Partial<ReviewRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setInvalidKeys((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const selected = rows.filter((row) => row.selected)
  const totals = useMemo(() => totalsByCurrency(rows), [rows])
  const sourceRow = rows.find((row) => row.key === sourceKey) ?? null
  const sourceShot = sourceRow ? shots.find((shot) => shot.id === sourceRow.shotId) : undefined
  const busy = shots.some((shot) => shot.status !== 'done' && shot.status !== 'failed')

  const confirm = async () => {
    setSaving(true)
    try {
      const { data } = await api.post<{ ids: number[] }>('/transactions/import', toImportPayload(rows))
      toast.success(t('Imported {{count}} transactions', { count: data.ids.length }))
      router.push('/transactions')
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        const indices: number[] = error.response.data?.invalidRows ?? []
        setInvalidKeys(new Set(indices.map((i) => selected[i]?.key).filter(Boolean) as string[]))
        toast.error(t('Some rows need fixing before they can be imported.'))
      } else if (!axios.isAxiosError(error) || !error.response || error.response.status < 500) {
        toast.error(t('The import failed. Nothing was saved.'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Head>
        <title>Import transactions - TermPocket</title>
        <meta name="description" content="Import transactions from bank screenshots and receipts" />
      </Head>

      <AppShell>
        <div>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
            <div className="flex items-center space-x-4">
              <div>
                <h1 className="text-2xl font-bold sm:text-3xl">{t('Import transactions')}</h1>
                <p className="text-muted-foreground">{t('From bank screenshots and receipt photos')}</p>
              </div>
            </div>
          </div>
        </div>

        <main className="max-w-7xl mx-auto space-y-6 px-2 pt-6 pb-8 sm:px-6 lg:px-8">
          <EngineBanner state={engine} onRetry={retry} />

          <Card>
            <CardContent className="space-y-4 pt-6">
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {t('Screenshots are read on this device. Only the recognised text is sent to TermPocket, and nothing is saved until you confirm.')}
              </p>
              <DropZone
                onFiles={addFiles}
                disabled={engine.status === 'unsupported' || engine.status === 'failed'}
              />
              {shots.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {shots.map((shot) => (
                    <li key={shot.id} className="space-y-2 p-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <ShotStatusIcon status={shot.status} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{shot.file.name}</span>
                        <span className="order-last w-full pl-7 text-xs text-muted-foreground sm:order-none sm:w-auto sm:pl-0">
                          {t(STATUS_LABEL[shot.status])}
                          {shot.layout && ` · ${t(LAYOUT_LABEL[shot.layout])}`}
                          {shot.durationMs !== undefined && shot.status === 'done'
                            && ` · ${t('Read in {{seconds}} s', { seconds: (shot.durationMs / 1000).toFixed(1) })}`}
                        </span>
                        {shot.status === 'failed' && (
                          <Button size="sm" variant="outline" onClick={() => { void process(shot) }}>{t('Try again')}</Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('Remove')}
                          disabled={shot.status === 'reading' || shot.status === 'parsing'}
                          onClick={() => removeShot(shot.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      {shot.error && <p className="text-sm text-destructive">{shot.error}</p>}
                      {shot.warnings.includes('no_text_found') && (
                        <p className="text-sm text-muted-foreground">{t('No text found in this image.')}</p>
                      )}
                      {shot.warnings.includes('ai_fallback_unavailable') && shot.unparsedLines.length === 0 && (
                        <p className="text-sm text-amber-600 dark:text-amber-400">
                          {t('Some rows could not be read with confidence. Check them before importing.')}
                        </p>
                      )}
                      {shot.unparsedLines.length > 0 && (
                        <div className="space-y-2 text-sm">
                          <p className="text-muted-foreground">
                            {t('No transactions found. The text we read is below; you can add them by hand.')}{' '}
                            <Link href="/transactions/new" className="underline">{t('Add manually')}</Link>
                          </p>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
                            {shot.unparsedLines.join('\n')}
                          </pre>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {rows.length > 0 && (
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>{t('Review')}</CardTitle>
                <CardDescription>
                  {t('Check each row against the screenshot before importing. The picture button shows where a row was read from.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ReviewTable
                  rows={rows}
                  invalidKeys={invalidKeys}
                  onChange={changeRow}
                  onShowSource={setSourceKey}
                />
                <div className="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <p className="font-medium">{t('Total selected')}</p>
                    {totals.length === 0 && <p className="text-muted-foreground">—</p>}
                    {totals.map(({ currency, income, expense }) => (
                      <p key={currency} className="tabular-nums text-muted-foreground">
                        {currency}: {t('Income')} {income} · {t('Expense')} {expense}
                      </p>
                    ))}
                  </div>
                  <Button onClick={confirm} disabled={selected.length === 0 || saving || busy}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    {t('Import {{count}} transactions', { count: selected.length })}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Dialog open={sourceRow !== null} onOpenChange={(open) => { if (!open) setSourceKey(null) }}>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{sourceRow?.description || t('Source')}</DialogTitle>
                <DialogDescription>{sourceShot?.file.name}</DialogDescription>
              </DialogHeader>
              {sourceRow && sourceShot?.image && (
                <SourcePreview
                  url={sourceShot.url}
                  image={sourceShot.image}
                  boxes={sourceRow.boxes}
                  alt={sourceShot.file.name}
                />
              )}
            </DialogContent>
          </Dialog>
        </main>
      </AppShell>
    </>
  )
}

function EngineBanner({ state, onRetry }: { state: ReturnType<typeof useOcr>['state']; onRetry: () => void }) {
  const { t } = useTranslation('common')
  if (state.status === 'loading') {
    const percent = state.total > 0 ? Math.round((state.loaded / state.total) * 100) : 0
    return (
      <div className="space-y-2 rounded-md border p-4" role="status">
        <p className="text-sm">{t('Downloading the reading model')} {state.total > 0 && `(${percent}%)`}</p>
        <Progress value={percent} />
        <p className="text-xs text-muted-foreground">{t('Only on first use; later visits load it from the browser cache.')}</p>
      </div>
    )
  }
  if (state.status === 'unsupported') {
    return (
      <div className="rounded-md border border-destructive/50 p-4 text-sm" role="alert">
        {t("This browser can't read screenshots on the device.")}{' '}
        <Link href="/transactions/new" className="underline">{t('Add manually')}</Link>
      </div>
    )
  }
  if (state.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/50 p-4 text-sm" role="alert">
        <span>{t('The reading model failed to load.')}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>{t('Try again')}</Button>
      </div>
    )
  }
  if (state.status === 'ready') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
        {t('Reading model ready')}
      </p>
    )
  }
  return null
}

function ShotStatusIcon({ status }: { status: ShotStatus }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
  if (status === 'failed') return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
  return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
}

export async function getStaticProps({ locale }: { locale: string }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  }
}
