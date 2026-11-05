/**
 * Whether a tour has been seen, per account: the dashboard's first-run tour,
 * and Pocky's, which opens on the first visit to the conversation page.
 *
 * Completion or a skip is remembered in localStorage under the user's id, so
 * each account sees each tour once per browser. Storage may be missing or throw
 * (private windows, blocked site data); then the in-memory set still keeps a
 * tour to at most once per page session.
 */
const seenThisSession = new Set<string>()

function tourMemory(prefix: string) {
  const storageKey = (): string => {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}') as { id?: number }
      return `${prefix}${user.id ?? 'unknown'}`
    } catch {
      return `${prefix}unknown`
    }
  }
  return {
    seen(): boolean {
      const key = storageKey()
      if (seenThisSession.has(key)) return true
      try {
        return localStorage.getItem(key) !== null
      } catch {
        return false
      }
    },
    /** Called when the tour opens on its own, so a remount cannot open it twice. */
    shown() {
      seenThisSession.add(storageKey())
    },
    /** Called when the tour closes for any reason: finished, skipped or dismissed. */
    markSeen() {
      const key = storageKey()
      seenThisSession.add(key)
      try {
        localStorage.setItem(key, 'done')
      } catch {
        // Remembered for this page session only.
      }
    },
  }
}

const dashboardTour = tourMemory('onboardingTour:')
export const tourSeen = dashboardTour.seen
export const markTourShown = dashboardTour.shown
export const markTourSeen = dashboardTour.markSeen

export const pockyTour = tourMemory('pockyTour:')
