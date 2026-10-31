import axios from 'axios'
import Swal from 'sweetalert2'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

// A request made in the background, whose caller handles (or ignores) every
// failure itself: the response interceptor raises no dialog for it. A 401
// still logs out, like everywhere else. Set `background: true` on reads the
// user did not ask for and would not understand an error dialog about, such
// as the dictation vocabulary fetched while the user speaks.
declare module 'axios' {
  export interface AxiosRequestConfig {
    background?: boolean
  }
}

// Where a personal agent connects to read totals; configured in its MCP client.
export const MCP_ENDPOINT_URL = `${API_BASE_URL}/mcp`

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Logout function
export const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  window.location.href = '/login'
}

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor to handle errors
api.interceptors.response.use(
  (response) => {
    return response
  },
  (error) => {
    const { response } = error

    // Conversation controls own every error and cancellation state. Keep the
    // shared authentication expiry behavior, without a second generic dialog.
    if (error.config?.url?.startsWith('/agent')) {
      if (response?.status === 401) logout()
      return Promise.reject(error)
    }

    // A background read (see `background` above) must never interrupt the
    // page with a dialog: its caller falls back quietly. A 401 still logs out.
    if (error.config?.background && response?.status !== 401) {
      return Promise.reject(error)
    }

    // Don't show automatic toast for auth endpoints (handled manually in components).
    // The screenshot import reports its own 4xx errors next to the row or image
    // they concern, so it is exempt too.
    const isAuthEndpoint = error.config?.url?.includes('/auth/')
    const handledByCaller = isAuthEndpoint || error.config?.url?.includes('/import')

    // The AI connections section reports its own 4xx next to the form or row
    // they concern — the token limit, a bad name, a wrong password (403), or a
    // token already revoked in another tab — so none of them should also
    // raise a generic dialog.
    const ownsClientErrors = error.config?.url?.startsWith('/access-tokens')
      && response?.status >= 400 && response?.status < 500 && response?.status !== 401
    if (ownsClientErrors) return Promise.reject(error)

    // Settings -> Automatic deletion reports its own failures in a toast next
    // to the control (unavailable, demo account, a failed preview).
    if (error.config?.url?.startsWith('/transactions/retention') && response?.status !== 401) {
      return Promise.reject(error)
    }

    // Settings -> Clear All Data says itself that the shared demo account
    // cannot be cleared (403 clear_demo), so no generic dialog is raised.
    if (/^\/(transactions|goals)\/clear-all$/.test(error.config?.url ?? '') && response?.data?.code === 'clear_demo') {
      return Promise.reject(error)
    }

    // Settings -> Delete account shows a wrong password, the demo refusal and
    // the rate limit inside its own dialog. A 401 still logs out.
    if (error.config?.url === '/auth/account' && response?.status !== 401) {
      return Promise.reject(error)
    }

    // The terms card handles its own errors: a failed status check lets the
    // app go on silently, and a failed accept shows a line inside the card.
    if (error.config?.url === '/auth/terms' && response?.status !== 401) {
      return Promise.reject(error)
    }

    // The goals page's top-up suggestion reads last month's totals in the
    // background and simply stays hidden when they fail (a missing exchange
    // rate is a 500), so no dialog should interrupt the page.
    if (error.config?.url?.startsWith('/summary/monthly') && response?.status !== 401) {
      return Promise.reject(error)
    }

    // The edit page reads one transaction and says "not found" itself, so a
    // missing, foreign or malformed id must not also raise the generic dialog.
    const ownsTransactionLookup = error.config?.method === 'get'
      && /^\/transactions\/[^/?]+$/.test(error.config?.url ?? '')
      && (response?.status === 400 || response?.status === 404)
    if (ownsTransactionLookup) return Promise.reject(error)

    if (response?.status === 401) {
      // Unauthorized - redirect to login
      logout()
    } else if (response?.status === 403) {
      Swal.fire({
        icon: 'error',
        title: 'Access denied',
        text: 'Access denied. You do not have permission to perform this action.',
      })
    } else if (response?.status === 404) {
      Swal.fire({
        icon: 'error',
        title: 'Resource not found',
        text: 'Resource not found.',
      })
    } else if (response?.status >= 500) {
      Swal.fire({
        icon: 'error',
        title: 'Server error',
        text: 'Server error. Please try again later.',
      })
    } else if (response?.data?.error && !handledByCaller) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: response.data.error,
      })
    } else if (!handledByCaller) {
      Swal.fire({
        icon: 'error',
        title: 'An unexpected error occurred',
        text: 'An unexpected error occurred.',
      })
    }

    return Promise.reject(error)
  }
)

export interface AccessToken {
  id: number
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  // An instant; null when the token never expires (only tokens from before
  // the backend's migration 023). `expired` is decided by the server's clock.
  expires_at: string | null
  expired: boolean
}

export const accessTokenAPI = {
  list: () => api.get<{ tokens: AccessToken[], limit: number }>('/access-tokens'),
  // The secret comes back once, in this response, and is never retrievable again.
  // The account password is re-checked by the server; it is sent once and never kept.
  create: (name: string, password: string) => api.post<{ token: AccessToken, secret: string }>('/access-tokens', { name, password }),
  revoke: (id: number) => api.delete<{ revoked: true }>(`/access-tokens/${id}`),
}

/** Where keeping the last `terms` terms draws the line today. */
export interface RetentionWindow {
  terms: number
  /** The first kept term, e.g. '2024-fall'. */
  keepFromTerm: string
  /** Its first day: transactions dated before it are deleted. */
  cutoff: string
}

export interface RetentionSetting {
  /** False until the server's migration 016 is applied. */
  available: boolean
  demo: boolean
  /** Terms kept, or null when automatic deletion is off. */
  retentionTerms: number | null
  choices: number[]
  window: RetentionWindow | null
}

export const retentionAPI = {
  get: () => api.get<RetentionSetting>('/transactions/retention-settings'),
  // Deletes nothing: what turning it on would delete today.
  preview: (terms: number) => api.get<RetentionWindow & { count: number }>('/transactions/retention-preview', { params: { terms } }),
  set: (retentionTerms: number | null) => api.put<RetentionSetting>('/transactions/retention-settings', { retentionTerms }),
}

export const accountAPI = {
  // Deletes the account and everything in it; the password is checked again.
  delete: (password: string) => api.delete<{ deleted: true }>('/auth/account', { data: { password } }),
}

export interface TermsStatus {
  currentVersion: string
  acceptedVersion: string | null
  // True when the version accepted is not the current one: asked once per version.
  required: boolean
}

export const termsAPI = {
  status: () => api.get<TermsStatus>('/auth/terms'),
  accept: (version: string) => api.post<TermsStatus>('/auth/terms', { version }),
}

export { api }
