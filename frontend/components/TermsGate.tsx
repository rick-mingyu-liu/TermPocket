import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Trans, useTranslation } from 'next-i18next'
import { Button } from '@/components/ui/button'
import { logout, termsAPI } from '@/utils/api'

// Pages a signed-out visitor can see, and the two documents the card links to.
const OPEN_PATHS = ['/login', '/register', '/verify-email', '/privacy', '/terms']

// For dialogs that open by themselves (the tours). One that mounted after the
// card would take the focus trap from beneath its overlay and leave neither
// usable, so they wait until the check has answered and no card is up. It
// starts as checking: the answer can land in the same render as whatever the
// tour waits for, before this module has heard of it.
let settled = false
const listeners = new Set<() => void>()
function setSettled(next: boolean) {
  if (next === settled) return
  settled = next
  listeners.forEach((listener) => listener())
}
/** True once the terms check has answered (or failed) and the card is not up. */
export function useTermsSettled(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => settled,
    () => false,
  )
}

/**
 * Asks a signed-in user to accept the Terms of Service and Privacy Policy when
 * the version they accepted is not the current one (GET /auth/terms). That is
 * once per version: accounts created before sign-up had a tick box, and
 * everyone again after the terms change. The card cannot be dismissed; the
 * only ways out are I agree and Log out.
 *
 * If the status cannot be read, the app goes on: a failed check must not lock
 * anyone out, and the next page load asks again.
 */
export default function TermsGate() {
  const { t } = useTranslation()
  const router = useRouter()
  const [version, setVersion] = useState<string | null>(null)
  // The token last checked. A ref, not state: setting state here would re-run
  // the effect, whose cleanup would then discard the answer still in flight.
  const checkedToken = useRef<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  // Until the first check answers; a page without one (no token, a public page) has nothing to wait for.
  const [checking, setChecking] = useState(true)

  const path = router.pathname
  useEffect(() => {
    if (OPEN_PATHS.includes(path)) { setChecking(false); return }
    let token: string | null = null
    try {
      token = localStorage.getItem('token')
    } catch {
      setChecking(false)
      return
    }
    if (!token) { setChecking(false); return }
    if (token === checkedToken.current) return
    checkedToken.current = token
    termsAPI.status()
      .then(({ data }) => setVersion(data.required ? data.currentVersion : null))
      // Forget the token so the next navigation asks again (a cold backend, say).
      .catch(() => { checkedToken.current = null })
      .finally(() => setChecking(false))
  }, [path])

  const accept = async () => {
    if (!version) return
    setSaving(true)
    setError(false)
    try {
      await termsAPI.accept(version)
      setVersion(null)
    } catch (e) {
      const response = (e as { response?: { status?: number; data?: { currentVersion?: string } } }).response
      // The terms changed while the card was open: show the new version's card.
      if (response?.status === 409 && response.data?.currentVersion) setVersion(response.data.currentVersion)
      else setError(true)
    } finally {
      setSaving(false)
    }
  }

  const open = version !== null && !OPEN_PATHS.includes(path)
  useEffect(() => {
    setSettled(!checking && !open)
  }, [checking, open])
  const link = 'font-medium underline underline-offset-2 hover:text-foreground'

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <DialogPrimitive.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[60] grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg"
        >
          <DialogPrimitive.Title className="text-lg font-semibold text-foreground">
            {t('termsGateTitle')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                <Trans
                  i18nKey="termsGateIntro"
                  t={t}
                  components={{
                    terms: <Link href="/terms" target="_blank" rel="noopener noreferrer" className={link} />,
                    privacy: <Link href="/privacy" target="_blank" rel="noopener noreferrer" className={link} />,
                  }}
                />
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>{t('termsGatePoint1')}</li>
                <li>{t('termsGatePoint2')}</li>
                <li>{t('termsGatePoint3')}</li>
              </ul>
            </div>
          </DialogPrimitive.Description>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{t('termsGateError')}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={logout} disabled={saving}>
              {t('Logout')}
            </Button>
            <Button className="bg-green-600 text-white hover:bg-green-700" onClick={accept} disabled={saving}>
              {saving ? t('termsGateAccepting') : t('termsGateAccept')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
