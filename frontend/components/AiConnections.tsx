import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Check, Copy, KeyRound, PlugZap, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'next-i18next'
import { AccessToken, MCP_ENDPOINT_URL, accessTokenAPI } from '@/utils/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog'

const NAME_MAX = 60
const COPY_TIMEOUT_MS = 1500

type CopyTarget = 'secret' | 'endpoint' | 'header' | 'claude-code-cmd' | 'claude-code-json' | 'codex-cmd' | 'codex-toml'

const CODEX_CMD = `codex mcp add termpocket --url "${MCP_ENDPOINT_URL}" --bearer-token-env-var TERMPOCKET_TOKEN`
const CODEX_TOML = `[mcp_servers.termpocket]
url = ${JSON.stringify(MCP_ENDPOINT_URL)}
bearer_token_env_var = "TERMPOCKET_TOKEN"`

const CLAUDE_CODE_CMD = `claude mcp add --transport http termpocket ${MCP_ENDPOINT_URL} \\
  --header "Authorization: Bearer <your token>"`
const CLAUDE_CODE_JSON = `{
  "mcpServers": {
    "termpocket": {
      "type": "http",
      "url": "${MCP_ENDPOINT_URL}",
      "headers": { "Authorization": "Bearer \${TERMPOCKET_TOKEN}" }
    }
  }
}`

// created_at and last_used_at are instants, not days, so lib/date.ts's day
// helpers do not apply; the viewer's own clock and locale name them.
function formatInstant(value: string, locale: string, withTime: boolean): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return withTime
    ? date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : date.toLocaleDateString(locale, { dateStyle: 'medium' })
}

function errorStatus(error: unknown): { status?: number, code?: string } {
  const response = (error as { response?: { status?: number, data?: { code?: string } } }).response
  return { status: response?.status, code: response?.data?.code }
}

/**
 * Personal access tokens for the read-only MCP endpoint.
 *
 * The secret is shown once, straight from the create response, and lives only
 * in this component's state: never storage, never the URL, never a log. It is
 * dropped on dismiss, and React discards it with the rest of the state when
 * the page unmounts.
 */
export default function AiConnections() {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.language

  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [limit, setLimit] = useState(5)
  const [loadFailed, setLoadFailed] = useState(false)
  const listRequestRef = useRef(0)

  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [secret, setSecret] = useState<string | null>(null)
  const [secretName, setSecretName] = useState('')
  const secretPanelRef = useRef<HTMLDivElement>(null)
  const secretCodeRef = useRef<HTMLElement>(null)
  const endpointCodeRef = useRef<HTMLElement>(null)
  const headerCodeRef = useRef<HTMLElement>(null)
  const cmdCodeRef = useRef<HTMLElement>(null)
  const jsonCodeRef = useRef<HTMLElement>(null)
  const codexCmdCodeRef = useRef<HTMLElement>(null)
  const codexTomlCodeRef = useRef<HTMLElement>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const [revoking, setRevoking] = useState<AccessToken | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)

  const load = useCallback(async () => {
    const request = ++listRequestRef.current
    try {
      const { data } = await accessTokenAPI.list()
      // A mutation starts a fresh load. An older response must not replace
      // that newer state, even when the network delivers it last.
      if (request !== listRequestRef.current) return
      setTokens(data.tokens)
      setLimit(data.limit)
      setLoadFailed(false)
    } catch {
      if (request !== listRequestRef.current) return
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Move focus to the one-time secret, so keyboard and screen-reader users
  // land on it rather than on a form that has just been cleared.
  useEffect(() => {
    if (secret) secretPanelRef.current?.focus()
  }, [secret])

  useEffect(() => {
    if (!copied) return
    // Clearing the announcement too lets a second copy be announced again.
    const timer = setTimeout(() => { setCopied(null); setAnnouncement('') }, 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const active = (tokens ?? []).filter((token) => !token.revoked_at)
  const revoked = (tokens ?? []).filter((token) => token.revoked_at)
  const atLimit = active.length >= limit
  const trimmed = name.trim()

  const selectText = (element: HTMLElement | null) => {
    if (!element) return
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const copy = async (target: CopyTarget, text: string, element: HTMLElement | null) => {
    try {
      // writeText can wait indefinitely on a permission prompt the user may
      // never see, so it gets a deadline rather than leaving the button mute.
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), COPY_TIMEOUT_MS)),
      ])
      setCopied(target)
      setAnnouncement(t('Copied to clipboard'))
    } catch {
      // No clipboard permission, no secure context, or no answer: select it
      // instead so a keyboard copy takes exactly the right text.
      // A toast, not just the live region: sighted users need to know too.
      selectText(element)
      toast(t('Could not copy automatically. The text is selected; press Ctrl+C or ⌘C.'), { id: 'ai-copy' })
    }
  }

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (creating || secret || !trimmed || trimmed.length > NAME_MAX || atLimit) return
    setCreating(true)
    setCreateError(null)
    try {
      const { data } = await accessTokenAPI.create(trimmed)
      setSecretName(data.token.name)
      setSecret(data.secret)
      setName('')
      setTokens((current) => [data.token, ...(current ?? [])])
      load()
    } catch (error) {
      const { status, code } = errorStatus(error)
      if (status === 409 || code === 'token_limit') {
        setCreateError(t('{{limit}} of {{limit}} connections in use — revoke one to add another.', { limit }))
        load()
      } else if (status === 400) {
        setCreateError(t('Give the connection a name of 1 to 60 characters.'))
      } else if (status === undefined || status < 500) {
        // 5xx and network failures already raise the app-wide error dialog.
        setCreateError(t('Could not create the connection. Please try again.'))
      }
    } finally {
      setCreating(false)
    }
  }

  const dismissSecret = () => {
    setSecret(null)
    setSecretName('')
    setCopied(null)
    window.getSelection()?.removeAllRanges()
    nameInputRef.current?.focus()
  }

  const handleRevoke = async () => {
    if (!revoking) return
    setRevokeBusy(true)
    try {
      await accessTokenAPI.revoke(revoking.id)
      toast.success(t('Connection revoked. Any app using it has lost access.'))
    } catch (error) {
      const { status } = errorStatus(error)
      // Already gone — revoked in another tab, say. The list reload shows it.
      if (status === 404) toast(t('That connection was already revoked.'))
      // 5xx and network failures already raise the app-wide error dialog.
      else if (status === undefined || status < 500) toast.error(t('Could not revoke the connection. Please try again.'))
    } finally {
      setRevokeBusy(false)
      setRevoking(null)
      // A limit error from before this revoke no longer holds.
      setCreateError(null)
    }
    load()
  }

  const copyIcon = (target: CopyTarget) =>
    copied === target ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="h-5 w-5" />
          {t('AI connections')}
        </CardTitle>
        <CardDescription>
          {t('Let an AI app read your summaries with a token you can revoke at any time.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-0.5">
          <Label className="text-base">{t('What it can read')}</Label>
          <p className="text-sm text-muted-foreground">
            {t('Term and monthly totals, top categories, spending pace and savings goals. Never individual transactions. Read-only: it cannot change anything.')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('The AI app handles these numbers under its own privacy terms.')}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="space-y-0.5">
            <Label className="text-base">{t('Set up an AI app')}</Label>
            <p className="text-sm text-muted-foreground">{t('Create a token below, then follow the guide for your app.')}</p>
          </div>
          <Button type="button" variant="outline" className="shrink-0 self-start sm:self-auto" onClick={() => setGuideOpen(true)}>
            <BookOpen className="w-4 h-4 mr-2" aria-hidden />
            {t('Setup guide')}
          </Button>
        </div>

        {secret && (
          <div
            ref={secretPanelRef}
            tabIndex={-1}
            role="region"
            aria-labelledby="ai-secret-heading"
            className="rounded-lg border-2 border-amber-500/70 bg-amber-50 p-4 space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-amber-950/40"
          >
            <h3 id="ai-secret-heading" className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
              <KeyRound className="h-4 w-4" aria-hidden />
              {t('Copy the token for “{{name}}” now — it is shown only once', { name: secretName })}
            </h3>
            <p className="text-sm text-amber-900 dark:text-amber-100">
              {t('Once you close this panel, TermPocket cannot show it again. Paste it into your AI client; if you lose it, revoke this connection and create a new one.')}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <code
                ref={secretCodeRef}
                className="flex-1 min-w-0 break-all rounded-md border border-amber-500/50 bg-background px-3 py-2 font-mono text-sm select-all"
              >
                {secret}
              </code>
              <Button
                type="button"
                className="h-auto shrink-0"
                onClick={() => copy('secret', secret, secretCodeRef.current)}
                aria-label={copied === 'secret' ? t('Copied') : t('Copy token')}
              >
                {copyIcon('secret')}
                <span className="ml-2">{copied === 'secret' ? t('Copied') : t('Copy token')}</span>
              </Button>
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={dismissSecret}>
                {t('I’ve copied it')}
              </Button>
            </div>
          </div>
        )}

        <form onSubmit={handleCreate} className="space-y-2" noValidate>
          <Label htmlFor="ai-connection-name" className="text-base">{t('New connection')}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="ai-connection-name"
              ref={nameInputRef}
              value={name}
              onChange={(event) => { setName(event.target.value); setCreateError(null) }}
              maxLength={NAME_MAX}
              placeholder={t('e.g. Claude on my laptop')}
              disabled={Boolean(secret) || atLimit || creating || tokens === null}
              aria-describedby="ai-connection-hint"
              aria-invalid={createError ? true : undefined}
              autoComplete="off"
            />
            <Button
              type="submit"
              className="shrink-0"
              disabled={Boolean(secret) || !trimmed || atLimit || creating || tokens === null}
            >
              <KeyRound className="w-4 h-4 mr-2" aria-hidden />
              {creating ? t('Creating...') : t('Create token')}
            </Button>
          </div>
          <p id="ai-connection-hint" className="text-sm text-muted-foreground" aria-live="polite">
            {secret
              ? t('Copy this token and dismiss its panel before creating another connection.')
              : atLimit
              ? t('{{limit}} of {{limit}} connections in use — revoke one to add another.', { limit })
              : t('Name it after the app or device that will use it. {{used}} of {{limit}} in use.', { used: active.length, limit })}
          </p>
          {/* At the limit the hint above already says why; don't say it twice. */}
          {createError && !atLimit && (
            <p role="alert" className="text-sm text-destructive">{createError}</p>
          )}
        </form>

        <section aria-labelledby="ai-active-heading" className="space-y-2">
          <h3 id="ai-active-heading" className="text-base font-medium">{t('Active connections')}</h3>
          {loadFailed ? (
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm">
              <span className="text-muted-foreground">{t('Could not load your connections.')}</span>
              <Button type="button" variant="outline" size="sm" onClick={load}>{t('Try again')}</Button>
            </div>
          ) : tokens === null ? (
            <p className="text-sm text-muted-foreground">{t('Loading...')}</p>
          ) : active.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {t('No connections yet.')}
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {active.map((token) => (
                <li key={token.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{token.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Created {{date}}', { date: formatInstant(token.created_at, locale, false) })}
                      <span aria-hidden> · </span>
                      <br className="sm:hidden" />
                      {token.last_used_at
                        ? t('Last used {{date}}', { date: formatInstant(token.last_used_at, locale, true) })
                        : t('Never used')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => setRevoking(token)}
                    aria-label={t('Revoke {{name}}', { name: token.name })}
                  >
                    <Trash2 className="w-4 h-4 sm:mr-2" aria-hidden />
                    <span className="hidden sm:inline">{t('Revoke')}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {revoked.length > 0 && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer select-none py-1">
                {t('Revoked connections ({{number}})', { number: revoked.length })}
              </summary>
              <ul className="mt-2 space-y-1 pl-4 opacity-75">
                {revoked.map((token) => (
                  <li key={token.id} className="break-words">
                    <span className="line-through">{token.name}</span>
                    {' — '}
                    {t('Revoked {{date}}', { date: formatInstant(token.revoked_at as string, locale, false) })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
        <p className="sr-only" aria-live="polite" role="status">{announcement}</p>
      </CardContent>

      <Dialog open={revoking !== null} onOpenChange={(open) => !open && !revokeBusy && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Revoke “{{name}}”?', { name: revoking?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('Revoking takes effect immediately: any app using this token loses access at once. This cannot be undone, but you can create a new connection later.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={revokeBusy}>{t('Cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleRevoke} disabled={revokeBusy}>
              {revokeBusy ? t('Revoking...') : t('Revoke access')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden">
          <DialogHeader className="pr-6">
            <DialogTitle>{t('Set up an AI app')}</DialogTitle>
            <DialogDescription>
              {t('Use your token with the endpoint and header below.')}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden break-words text-sm">
            <section aria-labelledby="ai-details-heading" className="space-y-3 rounded-lg border p-3">
              <h4 id="ai-details-heading" className="font-medium">{t('Connection details')}</h4>
              <div className="space-y-1.5">
                <p className="text-muted-foreground">{t('MCP endpoint')}</p>
                <div className="flex items-stretch gap-2">
                  <code ref={endpointCodeRef} className="flex-1 min-w-0 break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs">{MCP_ENDPOINT_URL}</code>
                  <Button type="button" variant="outline" size="sm" className="h-auto shrink-0"
                    onClick={() => copy('endpoint', MCP_ENDPOINT_URL, endpointCodeRef.current)}
                    aria-label={copied === 'endpoint' ? t('Copied') : t('Copy endpoint URL')}>
                    {copyIcon('endpoint')}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-muted-foreground">{t('Request header')}</p>
                <div className="flex items-stretch gap-2">
                  <code ref={headerCodeRef} className="flex-1 min-w-0 break-words rounded-md border bg-muted px-3 py-2 font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>
                  <Button type="button" variant="outline" size="sm" className="h-auto shrink-0"
                    onClick={() => copy('header', 'Authorization: Bearer <token>', headerCodeRef.current)}
                    aria-label={copied === 'header' ? t('Copied') : t('Copy header format')}>
                    {copyIcon('header')}
                  </Button>
                </div>
              </div>
            </section>
            <Tabs defaultValue="claude-code" className="min-w-0">
              <TabsList className="h-auto flex-wrap justify-start">
                <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
                <TabsTrigger value="codex">Codex</TabsTrigger>
                <TabsTrigger value="claude">{t('Claude (claude.ai)')}</TabsTrigger>
                <TabsTrigger value="other">{t('Other apps')}</TabsTrigger>
              </TabsList>
              <TabsContent value="codex" className="space-y-3">
                <p>{t('Set TERMPOCKET_TOKEN to your token (without Bearer). Keep it out of shared files.')}</p>
                <p className="text-muted-foreground">{t('Bash/Zsh: run read -r -s TERMPOCKET_TOKEN, paste your token and press Enter, then run export TERMPOCKET_TOKEN.')}</p>
                <p>{t('Run this command:')}</p>
                <div className="flex items-stretch gap-2">
                  <pre className="min-w-0 max-w-full flex-1 whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"><code ref={codexCmdCodeRef}>{CODEX_CMD}</code></pre>
                  <Button type="button" variant="outline" size="sm" className="h-auto shrink-0"
                    onClick={() => copy('codex-cmd', CODEX_CMD, codexCmdCodeRef.current)}
                    aria-label={copied === 'codex-cmd' ? t('Copied') : t('Copy command')}>
                    {copyIcon('codex-cmd')}
                  </Button>
                </div>
                <p>{t('Or add this to ~/.codex/config.toml:')}</p>
                <div className="flex items-stretch gap-2">
                  <pre className="min-w-0 max-w-full flex-1 whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"><code ref={codexTomlCodeRef}>{CODEX_TOML}</code></pre>
                  <Button type="button" variant="outline" size="sm" className="h-auto shrink-0"
                    onClick={() => copy('codex-toml', CODEX_TOML, codexTomlCodeRef.current)}
                    aria-label={copied === 'codex-toml' ? t('Copied') : t('Copy config')}>
                    {copyIcon('codex-toml')}
                  </Button>
                </div>
                <p>{t('Start Codex from the same terminal. For the app or IDE, make TERMPOCKET_TOKEN available to its process, then restart it.')}</p>
                <p>{t('In Codex CLI, use /mcp to check the connection, then ask about your term spending. No OAuth login needed.')}</p>
                <a href="https://developers.openai.com/codex/mcp/" target="_blank" rel="noopener noreferrer" className="inline-block underline underline-offset-4">
                  {t('Codex documentation')}
                </a>
              </TabsContent>
              <TabsContent value="claude-code" className="space-y-3">
                <p>{t('Run this in a terminal. The endpoint is already filled in for this site.')}</p>
                <div className="flex items-stretch gap-2">
                  <pre className="min-w-0 max-w-full flex-1 whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"><code ref={cmdCodeRef}>{CLAUDE_CODE_CMD}</code></pre>
                  <Button type="button" variant="outline" size="sm" className="h-auto shrink-0"
                    onClick={() => copy('claude-code-cmd', CLAUDE_CODE_CMD, cmdCodeRef.current)}
                    aria-label={copied === 'claude-code-cmd' ? t('Copied') : t('Copy command')}>
                    {copyIcon('claude-code-cmd')}
                  </Button>
                </div>
                <p>{t('Then run claude mcp get termpocket. It should say Connected.')}</p>
                <p className="text-muted-foreground">{t('To share a project config file, never put the token in it. Reference an environment variable instead:')}</p>
                <div className="flex items-stretch gap-2">
                  <pre className="min-w-0 max-w-full flex-1 whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"><code ref={jsonCodeRef}>{CLAUDE_CODE_JSON}</code></pre>
                  <Button type="button" variant="outline" size="sm" className="h-auto shrink-0"
                    onClick={() => copy('claude-code-json', CLAUDE_CODE_JSON, jsonCodeRef.current)}
                    aria-label={copied === 'claude-code-json' ? t('Copied') : t('Copy config')}>
                    {copyIcon('claude-code-json')}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <ol className="list-decimal space-y-1 pl-5">
                  <li>{t('In Claude, open Settings and add a custom connector.')}</li>
                  <li>{t('Paste the MCP endpoint shown above as the connector URL.')}</li>
                  <li>{t('In the request headers setting, add Authorization with the value Bearer <your token>.')}</li>
                </ol>
                <p className="text-muted-foreground">{t('This needs a public HTTPS endpoint. It has not been tested with TermPocket yet.')}</p>
              </TabsContent>
              <TabsContent value="other" className="space-y-2">
                <p>{t('Any app that supports remote MCP servers over HTTP with a custom header can connect: use the endpoint above and the header Authorization: Bearer <your token>.')}</p>
                <p className="text-muted-foreground">{t('Apps that only support signing in with OAuth cannot connect.')}</p>
              </TabsContent>
            </Tabs>
            <p className="text-muted-foreground">
              {t('If an app reports 401, the token is wrong or revoked, or the header lacks “Bearer ”. Create a new token. Your TermPocket login does not work here.')}
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t('Close')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
