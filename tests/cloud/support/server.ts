// The local Feather Cloud the cloud tests run against (AGENTS.md, "Accounts build and local Feather Cloud"), and the
// steps they share: a fresh address per browser context, verification codes from the server's log, and signing up
// through the app's own screens.
import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, type Leaks } from '../../e2e/fixtures'

export const CLOUD = 'http://localhost:8420'
const COMPOSE = new URL('../../../../server/deploy/docker-compose.yml', import.meta.url).pathname
const run = promisify(execFile)

/** A new address nobody has used: `web-<random>@example.com`. */
export const newEmail = (): string => `web-${randomUUID().slice(0, 8)}@example.com`

/** The newest verification code the server's log mailer (FEATHER_MAIL=log) wrote for `email`, as the Swift
 *  integration harness reads it: `mail to <email>: Your Feather Cloud code is <6 digits>. …` */
export async function verificationCode(email: string): Promise<string> {
  const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:${homedir()}/.orbstack/bin:/usr/local/bin:/opt/homebrew/bin` }
  const pattern = `mail to ${email}: Your Feather Cloud code is `
  for (let i = 0; i < 25; i++) {
    const { stdout } = await run('docker', ['compose', '-f', COMPOSE, 'logs', '--no-log-prefix', '--since', '15m', 'server'], { env, maxBuffer: 64 << 20 })
    const line = stdout.split('\n').findLast((l) => l.includes(pattern))
    const code = line && /code is (\d{6})/.exec(line)?.[1]
    if (code) return code
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no verification code for ${email} in the server log`)
}

/** Lets the context reach the cloud, from an address of its own. The server's rate limits count per address (5
 *  signups an hour); started with FEATHER_TRUST_PROXY=true it reads X-Forwarded-For, as the Swift harness relies on,
 *  so each context counts apart. Without it the header is ignored and the limits are shared. */
export async function useCloud(context: BrowserContext, leaks: Leaks): Promise<void> {
  leaks.allowCloud(CLOUD)
  const ip = `10.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
  await context.route(`${CLOUD}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }))
}

export const PASSWORD = 'correct horse battery staple'

/** Creates an account through the five steps, from the demo; ends on the account's (empty) notes. Returns the
 *  recovery key shown on step 4. */
export async function signUp(page: Page, email: string, password = PASSWORD): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('textbox', { name: 'Verification code' }).fill(await verificationCode(email))
  await page.getByRole('button', { name: 'Verify email' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery key' })).toBeVisible()
  const key = (await page.getByLabel(/^Recovery key:/).textContent())!.trim()
  await page.getByRole('checkbox', { name: "I've saved my recovery key somewhere safe" }).check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start writing' }).click()
  await expect(accountMenu(page, email)).toBeVisible()
  return key
}

/** Logs in from /login with the password. */
export async function logIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(accountMenu(page, email)).toBeVisible({ timeout: 15_000 })
}

export const accountMenu = (page: Page, email: string) => page.getByRole('button', { name: `Account, ${email}` })

/** Writes a note in the open account and waits until the server has it. */
export async function writeNote(page: Page, title: string, body: string): Promise<void> {
  await page.getByRole('button', { name: /^Account, / }).focus()
  await page.keyboard.press('Alt+n')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note' }).click()
  await page.keyboard.type(body)
  // the tab pushes 2 s after the last change (after the 500 ms save), everything typed so far in one push
  await page.waitForResponse((r) => r.url().includes('/v1/sync/push') && r.ok(), { timeout: 15_000 })
}
