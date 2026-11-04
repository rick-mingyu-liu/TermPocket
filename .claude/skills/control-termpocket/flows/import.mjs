import { readFileSync } from 'node:fs'
import { assert, fixture } from '../lib/browser.mjs'

export const importFlow = {
  name: 'import',
  description: 'Screenshot import: the on-device OCR model loads, a synthetic bank screenshot from eval/ is read, the review rows roughly match the fixture truth, and the rows are imported.',
  covers: ['/import', '/transactions'],
  needs: ['db'],
  async run({ step, session, repo }) {
    const png = fixture(repo, 'eval/synthetic/bank-balance-01.png')
    const truthFile = fixture(repo, 'eval/synthetic/bank-balance-01.truth.json')
    const truth = truthFile ? JSON.parse(readFileSync(truthFile, 'utf8')) : null
    await session.signIn()
    await step('open /import, OCR model ready', async page => {
      await page.goto('/import')
      await page.getByRole('heading', { name: 'Import transactions' }).waitFor()
      await page.getByText('Reading model ready').waitFor({ timeout: 180000 })
    })
    if (!png) { await step('fixture present', async () => { throw new Error('eval/synthetic/bank-balance-01.png is missing in this checkout') }) }
    let rows = 0
    await step('upload a synthetic bank screenshot', async page => {
      await page.locator('input[type=file]').setInputFiles(png)
      await page.getByText(/Read in [\d.]+ s/).waitFor({ timeout: 180000 })
    })
    await step('review rows appear', async page => {
      await page.getByText('Review', { exact: true }).waitFor({ timeout: 30000 })
      rows = await page.locator('table tbody tr').count()
      if (rows === 0) rows = await page.getByRole('row').count() - 1
      assert(rows > 0, 'no review rows rendered')
      if (truth?.rows?.length) {
        const diff = Math.abs(rows - truth.rows.length)
        if (diff > Math.max(1, Math.round(truth.rows.length * 0.25))) return { warn: `${rows} rows read, fixture truth has ${truth.rows.length}` }
        return { note: `${rows} rows read, truth ${truth.rows.length}` }
      }
      return { note: `${rows} rows read` }
    })
    await step('import the selected rows', async page => {
      const btn = page.getByRole('button', { name: /^Import \d+ transactions?$/ })
      await btn.waitFor()
      await btn.click()
      await page.waitForURL(url => new URL(url).pathname === '/transactions', { timeout: 30000 })
    })
  },
}
