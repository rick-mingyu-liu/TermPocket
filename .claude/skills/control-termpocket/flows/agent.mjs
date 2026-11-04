import { assert } from '../lib/browser.mjs'

const MIC = 'Dictate a message (English only)'
const STOP = 'Stop recording'

export const agent = {
  name: 'agent',
  description: 'The Pocky page renders signed in with the composer, Send and microphone enabled; nothing is sent. With CONTROL_AGENT=1 and CLAUDE_API_KEY one typed turn drafts a transaction (paid).',
  covers: ['/agent'],
  needs: ['db'],
  async run({ step, session, env }) {
    await session.signIn()
    await step('open /agent', async page => {
      await page.goto('/agent')
      await page.getByRole('log', { name: 'Conversation messages' }).or(page.getByText('Your message')).first().waitFor({ timeout: 20000 })
    })
    if (env.CONTROL_AGENT !== '1') {
      await step('composer, send and microphone are enabled (placeholder key, nothing sent)', async page => {
        const box = page.getByPlaceholder(/Tell me what you spent/)
        await box.waitFor()
        await page.waitForFunction(() => { const t = document.querySelector('textarea'); return t && !t.disabled }, null, { timeout: 15000 })
        await box.fill('Coffee 4.50 today')
        const send = page.getByRole('button', { name: 'Send' })
        await send.waitFor()
        await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Send'); return b && !b.disabled }, null, { timeout: 10000 })
        assert(await page.getByRole('button', { name: MIC }).count() === 1, 'microphone button missing')
        await box.fill('')
        return { note: 'no turn sent; set CONTROL_AGENT=1 and CLAUDE_API_KEY for a real one' }
      })
      return
    }
    await step('send one typed message', async page => {
      const box = page.getByPlaceholder(/Tell me what you spent/)
      await box.waitFor()
      await page.waitForFunction(() => { const t = document.querySelector('textarea'); return t && !t.disabled }, null, { timeout: 15000 })
      await box.fill('Coffee 4.50 today')
      await page.getByRole('button', { name: 'Send' }).click()
      await page.getByText(/coffee/i).nth(1).waitFor({ timeout: 120000 })
    })
  },
}

export const dictate = {
  name: 'dictate',
  description: 'Voice dictation on /agent with a fake microphone: the Whisper model loads from /voice, a recording starts and stops, and a transcript (or the no-speech message) comes back.',
  covers: ['/agent'],
  needs: ['db'],
  async run({ step, session, env }) {
    await session.signIn()
    await step('open /agent', async page => {
      await page.goto('/agent')
      await page.getByRole('button', { name: MIC }).waitFor({ timeout: 20000 })
    })
    await step('load the speech model', async page => {
      await page.getByRole('button', { name: MIC }).click()
      await page.getByText(/Speech model ready/).waitFor({ timeout: 300000 })
    })
    await step('record for 4 s', async page => {
      await page.getByRole('button', { name: MIC }).click()
      await page.getByRole('button', { name: STOP }).waitFor({ timeout: 15000 })
      await page.waitForTimeout(4000)
      await page.getByRole('button', { name: STOP }).click()
    })
    await step('transcript or no-speech', async page => {
      // Wait for either text in the composer or a non-empty dictation error (an empty
      // role=alert container can exist on the page while transcribing).
      await page.waitForFunction(() => {
        const t = document.querySelector('textarea')
        const alerts = [...document.querySelectorAll('[role=alert]')].map(a => a.textContent?.trim() || '').filter(Boolean)
        return (t && t.value.trim().length > 0) || alerts.length > 0
      }, null, { timeout: 120000 })
      const text = await page.locator('textarea').first().inputValue()
      const alert = (await page.locator('[role=alert]').allInnerTexts().catch(() => [])).map(s => s.trim()).filter(Boolean).join(' | ')
      if (text.trim()) {
        if (env.CONTROL_AUDIO_EXPECT && !new RegExp(env.CONTROL_AUDIO_EXPECT, 'i').test(text)) return { warn: `transcript ${JSON.stringify(text)} does not match /${env.CONTROL_AUDIO_EXPECT}/` }
        return { note: `transcript: ${JSON.stringify(text)}` }
      }
      if (env.CONTROL_AUDIO_FILE) throw new Error(`no transcript from the spoken file: ${alert}`)
      return { warn: `no transcript (fake tone, expected): ${alert}` }
    })
  },
}
