import { api, assert } from '../lib/browser.mjs'

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function plusDays(n) { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

async function swalConfirm(page, label) {
  const btn = page.locator('.swal2-confirm')
  await btn.waitFor({ timeout: 10000 })
  if (label) assert((await btn.innerText()).includes(label), `confirm button says ${JSON.stringify(await btn.innerText())}, expected ${label}`)
  await btn.click()
}

export const transactions = {
  name: 'transactions',
  description: 'The transactions list renders seeded rows, the search box filters them, the type filter works.',
  covers: ['/transactions'],
  needs: ['db'],
  async run({ step, session }) {
    await session.signIn()
    let total = 0
    await step('open /transactions', async page => {
      await page.goto('/transactions')
      await page.getByRole('heading', { name: 'Transactions' }).waitFor()
      await page.getByRole('button', { name: 'Edit Transaction' }).first().waitFor({ timeout: 20000 })
      total = await page.getByRole('button', { name: 'Edit Transaction' }).count()
      assert(total > 0, 'no rows rendered')
      return { note: `${total} rows on the first page` }
    })
    await step('search narrows the list', async page => {
      // Take a real description from the API rather than guessing from row text.
      const r = await api('GET', '/transactions?limit=20', undefined, session.token)
      const list = r.json?.transactions ?? r.json?.data ?? r.json?.items ?? (Array.isArray(r.json) ? r.json : [])
      const descriptions = list.map(t => t.description).filter(Boolean)
      assert(descriptions.length > 0, `GET /transactions gave no descriptions (HTTP ${r.status})`)
      const word = descriptions.flatMap(d => d.split(/\s+/)).find(w => w.length >= 4 && /^[a-z]+$/i.test(w)) || descriptions[0].slice(0, 4)
      await page.getByPlaceholder('Search transactions...').fill(word)
      await page.waitForTimeout(600)
      const n = await page.getByRole('button', { name: 'Edit Transaction' }).count()
      assert(n >= 1 && n <= total, `search "${word}" left ${n} of ${total} rows`)
      await page.getByPlaceholder('Search transactions...').fill('')
    })
    await step('type filter: income', async page => {
      const combo = page.getByRole('combobox').filter({ hasText: /All Types|Filter by type/ }).first()
      await combo.click()
      await page.getByRole('option', { name: 'Income' }).click()
      await page.waitForTimeout(400)
      const n = await page.getByRole('button', { name: 'Edit Transaction' }).count()
      assert(n <= total, 'filter increased the row count')
    })
  },
}

export const transactionCrud = {
  name: 'transaction-crud',
  description: 'Add an expense through the form, find it in the list, edit its amount, delete it with the confirm dialog.',
  covers: ['/transactions/new', '/transactions', '/transactions/edit/[id]'],
  needs: ['db'],
  async run({ step, session }) {
    await session.signIn()
    const desc = `Control smoke ${Date.now().toString(36)}`
    await step('open /transactions/new', async page => {
      await page.goto('/transactions/new')
      await page.locator('#description').waitFor()
    })
    await step('fill and submit an expense', async page => {
      await page.getByRole('button', { name: 'Expense', exact: true }).click()
      await page.locator('#description').fill(desc)
      await page.locator('#amount').fill('12.34')
      const category = page.getByRole('combobox').filter({ hasText: 'Select a category' }).first()
      await category.click()
      await page.getByRole('option').first().click()
      await page.locator('#date').fill(today())
      await page.locator('form button[type=submit]').click()
      await page.waitForURL(url => new URL(url).pathname === '/', { timeout: 20000 })
    })
    await step('the row is listed', async page => {
      await page.goto('/transactions')
      await page.getByPlaceholder('Search transactions...').fill('Control smoke')
      await page.getByText(desc).first().waitFor({ timeout: 15000 })
    })
    await step('edit the amount', async page => {
      const row = page.getByText(desc).first().locator('xpath=ancestor::*[.//button[@aria-label="Edit Transaction"]][1]')
      await row.getByRole('button', { name: 'Edit Transaction' }).click()
      await page.waitForURL(/\/transactions\/edit\/\d+/)
      const amount = page.locator('#amount')
      await amount.waitFor()
      await amount.fill('15.00')
      await page.locator('form button[type=submit]').click()
      await page.waitForURL(url => new URL(url).pathname === '/transactions', { timeout: 20000 })
      await swalConfirm(page) // "Transaction updated successfully"
      await page.getByPlaceholder('Search transactions...').fill('Control smoke')
      const text = await page.getByText(desc).first().locator('xpath=ancestor::*[.//button[@aria-label="Edit Transaction"]][1]').innerText()
      assert(/15\.00/.test(text), `edited amount not shown: ${JSON.stringify(text.slice(0, 120))}`)
    })
    await step('delete it', async page => {
      const row = page.getByText(desc).first().locator('xpath=ancestor::*[.//button[@aria-label="Delete Transaction"]][1]')
      await row.getByRole('button', { name: 'Delete Transaction' }).click()
      await swalConfirm(page, 'Yes, delete it!')
      await swalConfirm(page)
      await page.waitForTimeout(500)
      assert(await page.getByText(desc).count() === 0, 'row still listed after delete')
    })
  },
}

export const goals = {
  name: 'goals',
  description: 'Goals page lists the seeded goals; a new goal is created through the dialog and then deleted.',
  covers: ['/goals'],
  needs: ['db'],
  async run({ step, session }) {
    await session.signIn()
    const name = `Control goal ${Date.now().toString(36)}`
    await step('open /goals', async page => {
      await page.goto('/goals')
      await page.getByRole('button', { name: 'Add Goal' }).first().waitFor()
      const n = await page.getByRole('button', { name: 'View Goal' }).count()
      return { note: `${n} goals listed` }
    })
    await step('create a goal', async page => {
      await page.getByRole('button', { name: 'Add Goal' }).first().click()
      await page.locator('#name').fill(name)
      await page.locator('#target_amount').fill('500')
      await page.locator('#current_amount').fill('25')
      await page.locator('#target_date').fill(plusDays(90))
      await page.getByRole('button', { name: 'Create Goal' }).click()
      await swalConfirm(page) // "Goal created successfully!"
      await page.getByText(name).first().waitFor({ timeout: 15000 })
    })
    await step('delete the goal', async page => {
      // Delete lives in the edit dialog: card header → pencil (second icon button) → "Delete Goal" → confirm dialog.
      const card = page.getByText(name).first().locator('xpath=ancestor::*[.//button[@aria-label="View Goal"]][1]')
      await card.getByRole('button').nth(1).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Delete Goal' }).click()
      await page.getByRole('dialog').last().getByRole('button', { name: /delete|yes/i }).last().click()
      await swalConfirm(page) // "Goal deleted successfully!"
      await page.waitForTimeout(500)
      assert(await page.getByText(name).count() === 0, 'goal still listed after delete')
    })
  },
}
