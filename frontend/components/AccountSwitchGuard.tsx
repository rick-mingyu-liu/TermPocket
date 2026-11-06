import { useEffect } from 'react'
import { useTranslation } from 'next-i18next'
import toast from 'react-hot-toast'

const NOTICE_KEY = 'accountSwitched'

/**
 * Keeps every open tab on the account the browser is signed in to.
 *
 * The session is one `token` in localStorage, shared by every tab, and the API
 * client reads it on each request. Signing in to another account in one tab
 * (the public demo, say) therefore moved every other tab's saves to that
 * account, while those tabs still showed the old account's data: entries typed
 * there landed in the demo. A `storage` event fires in the other tabs when the
 * token changes, so each one starts over on the dashboard of the account now
 * signed in, and says why; signing out elsewhere sends it to the sign-in page.
 * A full navigation, not router.push, so no page keeps state from the old
 * account.
 */
export default function AccountSwitchGuard() {
  const { t } = useTranslation('common')

  useEffect(() => {
    try {
      if (sessionStorage.getItem(NOTICE_KEY)) {
        sessionStorage.removeItem(NOTICE_KEY)
        toast(t('accountSwitched'), { duration: 6000 })
      }
    } catch {
      // No session storage: the tab still switches, just without the note.
    }

    const onStorage = (event: StorageEvent) => {
      // key is null when another tab cleared the whole storage.
      if (event.storageArea !== localStorage || (event.key !== 'token' && event.key !== null)) return
      const token = localStorage.getItem('token')
      if (event.key === 'token' && event.oldValue === event.newValue) return
      if (!token) {
        window.location.assign('/login')
        return
      }
      // Signed in from signed out is not a switch, so no note then.
      if (event.oldValue) {
        try { sessionStorage.setItem(NOTICE_KEY, '1') } catch { /* see above */ }
      }
      window.location.assign('/')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [t])

  return null
}
