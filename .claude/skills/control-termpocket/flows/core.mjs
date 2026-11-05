import { assert, rawKeys } from '../lib/browser.mjs'
import { DEMO } from '../lib/stack.mjs'

const MONEY = /[-−]?\$?\s?\d[\d,]*\.\d{2}/

export const login = {
  name: 'login',
  description: 'Sign in through the form as the demo account and land on the dashboard.',
  covers: ['/login', '/'],
  needs: ['db'],
  async run({ step }) {
    await step('open /login', async page => {
      await page.goto('/login')
      await page.getByPlaceholder('Enter your email').waitFor()
    })
    await step('submit demo credentials', async page => {
      await page.getByPlaceholder('Enter your email').fill(DEMO.email)
      await page.getByPlaceholder('Enter your password').fill(DEMO.password)
      const submit = page.locator('form button[type=submit]')
      await submit.waitFor()
      await page.waitForFunction(() => !document.querySelector('form button[type=submit]')?.disabled)
      await submit.click()
      await page.waitForURL(url => new URL(url).pathname === '/', { timeout: 30000 })
    })
    await step('dashboard renders', async page => {
      await page.getByText('Recent Transactions').first().waitFor()
      assert(await page.evaluate(() => !!localStorage.getItem('token')), 'no token in localStorage after login')
    })
  },
}

export const dashboard = {
  name: 'dashboard',
  description: 'The dashboard shows totals for the current term, the period selector switches windows, the category chart has both tabs.',
  covers: ['/'],
  needs: ['db'],
  async run({ step, session }) {
    await session.signIn()
    await step('open / signed in', async page => {
      await page.goto('/')
      await page.getByText('Recent Transactions').first().waitFor()
    })
    await step('totals tiles show money', async page => {
      for (const title of ['Total Income', 'Total Expenses', 'Net Income']) {
        // The shadcn Card root is the nearest ancestor div with a `border` class.
        const card = page.getByText(title, { exact: true }).first().locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " border ")][1]')
        const text = await card.innerText()
        assert(MONEY.test(text), `${title} tile has no money amount: ${JSON.stringify(text.slice(0, 80))}`)
      }
    })
    await step('period selector: Last term', async page => {
      const before = await page.locator('main').innerText().catch(() => page.locator('body').innerText())
      // The period selector is a tab list: This term / Last term / This year / Last year.
      await page.getByRole('tab', { name: 'Last term' }).click()
      await page.waitForLoadState('networkidle')
      const after = await page.locator('main').innerText().catch(() => page.locator('body').innerText())
      if (before === after) return { warn: 'page text identical after switching period (no transactions last term?)' }
    })
    await step('category chart tabs', async page => {
      await page.getByRole('tab', { name: 'Income' }).click()
      await page.getByRole('tab', { name: 'Spending' }).click()
    })
    await step('recent transactions list has rows', async page => {
      const rows = page.getByRole('button', { name: 'Edit Transaction' })
      const n = await rows.count().catch(() => 0)
      if (n === 0) {
        const text = await page.getByText('Recent Transactions').first().locator('xpath=ancestor::div[contains(@class,"rounded")][1]').innerText().catch(() => '')
        assert(MONEY.test(text), 'no recent transactions rendered')
      }
    })
  },
}

export const settings = {
  name: 'settings',
  description: 'Settings: theme switches to dark and back, language switches to Chinese and back. Never touches the danger zone.',
  covers: ['/settings'],
  needs: ['db'],
  async run({ step, session }) {
    await session.signIn()
    await step('open /settings', async page => {
      await page.goto('/settings')
      await page.getByRole('heading', { name: 'Settings' }).waitFor()
    })
    await step('theme → dark → light', async page => {
      const group = page.getByRole('radiogroup', { name: 'Theme' })
      await group.waitFor()
      const dark = group.getByRole('radio', { name: /dark/i }).or(group.getByText(/^dark$/i)).first()
      await dark.click()
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5000 })
      const light = group.getByRole('radio', { name: /light/i }).or(group.getByText(/^light$/i)).first()
      await light.click()
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, { timeout: 5000 })
    })
    await step('language → 中文 → English', async page => {
      const field = page.locator('#language')
      await field.waitFor()
      const tag = await field.evaluate(el => el.tagName.toLowerCase())
      // Options are "System" / "English" / "Mandarin", translated once the locale flips.
      if (tag === 'select') await field.selectOption('zh')
      else { await field.click(); await page.getByRole('option', { name: /mandarin|中文|普通话|汉语/i }).click() }
      await page.waitForURL(/\/zh\//, { timeout: 15000 })
      await page.getByRole('heading', { name: '设置' }).waitFor()
      const field2 = page.locator('#language')
      await field2.waitFor()
      const tag2 = await field2.evaluate(el => el.tagName.toLowerCase())
      if (tag2 === 'select') await field2.selectOption('en')
      else { await field2.click(); await page.getByRole('option', { name: /english|英/i }).first().click() }
      await page.waitForURL(url => !/\/zh\//.test(url.toString()), { timeout: 15000 })
      await page.getByRole('heading', { name: 'Settings' }).waitFor()
    })
    await step('danger zone is present and untouched', async page => {
      // A collapsed <details>: open it to see the buttons, click none of them.
      const summary = page.locator('details summary', { hasText: 'Danger zone' })
      await summary.waitFor()
      await summary.click()
      await page.getByRole('button', { name: 'Clear All Data' }).waitFor({ timeout: 5000 })
    })
  },
}

const PUBLIC = ['/login', '/register', '/privacy', '/terms', '/verify-email']

export const pages = {
  name: 'pages',
  description: 'Every public page in English and Chinese: HTTP 200, no console errors, no untranslated keys; the two legacy redirects land.',
  covers: ['/login', '/register', '/privacy', '/terms', '/verify-email', '/investments', '/ai-planning'],
  needs: [],
  async run({ step }) {
    for (const locale of ['', '/zh']) {
      for (const path of PUBLIC) {
        const url = `${locale}${path}`
        await step(`GET ${url}`, async page => {
          const res = await page.goto(url, { waitUntil: 'networkidle' })
          assert(res && res.status() === 200, `HTTP ${res?.status()}`)
          const text = await page.locator('body').innerText()
          const keys = rawKeys(text)
          assert(keys.length === 0, `untranslated keys: ${keys.slice(0, 5).join(', ')}`)
          assert(text.trim().length > 10, 'page body is nearly empty')
        })
      }
    }
    await step('/investments redirects home', async page => {
      await page.goto('/investments')
      await page.waitForURL(url => /\/(login)?$/.test(new URL(url).pathname), { timeout: 15000 })
    })
    await step('/ai-planning redirects to /agent', async page => {
      await page.goto('/ai-planning')
      await page.waitForURL(url => /\/(agent|login)$/.test(new URL(url).pathname), { timeout: 15000 })
    })
  },
}
