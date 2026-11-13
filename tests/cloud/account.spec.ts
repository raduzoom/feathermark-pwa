// Create account, log in and recovery against the local Feather Cloud (Phase 20 Task 11; web design "Testing" item 4:
// no screen implies a password can be reset without the recovery key).
import type { Page } from '@playwright/test'
import { test, expect } from '../e2e/fixtures'
import { accountMenu, CLOUD, logIn, newEmail, PASSWORD, signUp, useCloud, verificationCode, writeNote } from './support/server'

const RECOVERY_BODY =
  "This key is the only way back into your notes if you forget your password. Feather Cloud never sees your password or your notes, so we can't reset it for you. Print it or save it somewhere safe, away from this device."
const PASSWORD_NOTE = "We never see this password, so we can't reset it for you. In step 4 you'll get a recovery key as your backup."
const WRONG_PASSWORD = "That password doesn't match. Forgot it? Sign in with your recovery key instead."

/** Failure mode 4: "reset" appears only inside the fixed copy, which says it can't be done. */
async function resetOnlyInFixedCopy(page: Page) {
  const texts = (await page.getByText(/reset/i).allTextContents()).map((t) => t.trim())
  for (const t of texts) expect([RECOVERY_BODY, PASSWORD_NOTE]).toContain(t)
  const all = await page.evaluate(() => document.body.innerText)
  expect(all).not.toMatch(/forgot (your )?password\?|reset (your )?password/i)
}

const step = (page: Page, n: number) => expect(page.getByText(`Step ${n} of 5`, { exact: true })).toBeVisible()

test('create an account in five steps', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  await context.addInitScript(() => {
    const w = window as unknown as { __printed: number; __copied: string[] }
    w.__printed = 0
    w.__copied = []
    window.print = () => void w.__printed++
    if (navigator.clipboard) navigator.clipboard.writeText = async (t: string) => void w.__copied.push(t)
  })
  const email = newEmail()
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/login\?create$/)

  // 1: the intro
  await step(page, 1)
  await expect(page.getByRole('heading', { name: 'Your notes, on every device' })).toBeVisible()
  await expect(page.getByText("Your notes are encrypted on this device before they're uploaded. Only your devices can read them.")).toBeVisible()
  await expect(page.getByText('Free during the first release.')).toBeVisible()
  await resetOnlyInFixedCopy(page)
  await page.getByRole('button', { name: 'Create account' }).click()

  // 2: email and password, with the strength line
  await step(page, 2)
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await expect(page.getByText(PASSWORD_NOTE)).toBeVisible()
  await expect(page.getByText('Use 12 or more characters. A few random words work well.')).toBeVisible()
  await resetOnlyInFixedCopy(page)
  const continueButton = page.getByRole('button', { name: 'Continue' })
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill('short')
  await expect(continueButton).toBeDisabled()
  await expect(page.getByText(/^(Fair|Good|Strong)$/)).toHaveCount(0)
  await page.getByLabel('Password').fill('ten chars!')
  await expect(page.getByText('Fair', { exact: true })).toBeVisible()
  await page.getByLabel('Password').fill(PASSWORD)
  await expect(page.getByText('Strong', { exact: true })).toBeVisible()
  await continueButton.click()

  // 3: the code from the server's log; Back is offered here
  await step(page, 3)
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(`We sent a 6-digit code to ${email}. It expires in 15 minutes.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resend code' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Verification code' }).fill(await verificationCode(email))
  await page.getByRole('button', { name: 'Verify email' }).click()

  // 4: the recovery key; Copy and Print…; Continue only once the box is ticked; Back stops here
  await step(page, 4)
  await expect(page.getByRole('heading', { name: 'Save your recovery key' })).toBeVisible()
  await expect(page.getByText(RECOVERY_BODY)).toBeVisible()
  await resetOnlyInFixedCopy(page)
  const key = (await page.getByLabel(/^Recovery key:/).textContent())!.trim()
  expect(key).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/)
  await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Copy' }).click()
  await page.getByRole('button', { name: 'Print…' }).click()
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([key])
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await page.getByRole('checkbox', { name: "I've saved my recovery key somewhere safe" }).check()
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  await page.getByRole('button', { name: 'Continue' }).click()

  // 5: done; the key is gone from the page; the account is open
  await step(page, 5)
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible()
  expect(await page.content()).not.toContain(key)
  await page.getByRole('button', { name: 'Start writing' }).click()
  await expect(accountMenu(page, email)).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toHaveCount(0)
})

test('log in on a second browser context with the password (a wrong one first)', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, 'From the first browser', 'written in context A')

  // a second device, watched by the leak fixture like the first (it closes it after the test)
  const other = await leaks.newContext()
  {
    await useCloud(other, leaks)
    const b = await other.newPage()
    await b.goto('/login')
    await b.getByRole('textbox', { name: 'Email' }).fill(email)
    await b.getByLabel('Password').fill('not the password at all')
    await b.getByRole('button', { name: 'Log in' }).click()
    await expect(b.getByRole('alert')).toHaveText(WRONG_PASSWORD, { timeout: 15_000 })
    await resetOnlyInFixedCopy(b)
    await b.getByLabel('Password').fill(PASSWORD)
    await b.getByRole('button', { name: 'Log in' }).click()
    await expect(accountMenu(b, email)).toBeVisible({ timeout: 15_000 })
    await expect(b).toHaveURL(/\/$/)
    await expect(b.getByRole('listbox', { name: 'Notes' }).getByRole('option', { name: /^From the first browser/ })).toBeVisible({ timeout: 15_000 })
  }
})

test('recover with the recovery key and set a new password; the other context is signed out', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  const key = await signUp(page, email)

  // a second device, watched by the leak fixture like the first (it closes it after the test)
  const other = await leaks.newContext()
  {
    await useCloud(other, leaks)
    const b = await other.newPage()
    const recoverCalls: string[] = []
    b.on('request', (r) => r.url().endsWith('/v1/auth/recover') && recoverCalls.push(r.url()))
    await b.goto('/login')
    await b.getByRole('textbox', { name: 'Email' }).fill(email)
    await b.getByRole('button', { name: 'Use recovery key instead' }).click()
    await expect(b.getByRole('heading', { name: 'Enter your recovery key' })).toBeVisible()
    await expect(b.getByText("Without your password or your recovery key, your notes can't be decrypted by anyone, including us.")).toBeVisible()
    await resetOnlyInFixedCopy(b)

    // a typo is caught before any request
    const typo = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')
    await b.getByRole('textbox', { name: 'Recovery key, 7 groups of 4' }).fill(typo)
    await b.getByRole('button', { name: 'Continue' }).click()
    await expect(b.getByRole('alert')).toHaveText('That recovery key has a typo. Check each group and try again.', { timeout: 15_000 })
    expect(recoverCalls).toEqual([])

    await b.getByRole('textbox', { name: 'Recovery key, 7 groups of 4' }).fill(key)
    await b.getByRole('button', { name: 'Continue' }).click()
    await expect(b.getByRole('heading', { name: 'Choose a new password' })).toBeVisible({ timeout: 15_000 })
    await expect(b.getByText('Recovery key accepted')).toBeVisible()
    await resetOnlyInFixedCopy(b)
    const next = 'a brand new password here'
    await b.getByLabel('New password', { exact: true }).fill(next)
    await b.getByLabel('Confirm new password').fill(next.slice(0, -1))
    await expect(b.getByRole('button', { name: 'Set password and sign in' })).toBeDisabled()
    await b.getByLabel('Confirm new password').fill(next)
    await b.getByRole('button', { name: 'Set password and sign in' }).click()
    await expect(accountMenu(b, email)).toBeVisible({ timeout: 15_000 })

    // A's session ended with the new password: its next sync (hiding the tab syncs at once) is refused, and the tab
    // locks asking to sign in again
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      delete (document as unknown as Record<string, unknown>).visibilityState
    })
    await expect(page.getByRole('heading', { name: `Sign in again as ${email}` })).toBeVisible({ timeout: 15_000 })
    await page.getByLabel('Password').fill(next)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(accountMenu(page, email)).toBeVisible({ timeout: 15_000 })
  }
})

test('/login opens the log-in screen; /login?create the create-account screen', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const cloud: string[] = []
  page.on('request', (r) => r.url().startsWith(CLOUD) && cloud.push(r.url()))
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Email' })).toBeFocused()
  await expect(page.getByLabel('Password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Use recovery key instead' })).toBeVisible()
  await resetOnlyInFixedCopy(page)
  // nothing is asked of the server until the form is used
  expect(cloud).toEqual([])
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()

  await page.goto('/login?create')
  await expect(page.getByRole('heading', { name: 'Your notes, on every device' })).toBeVisible()
  await page.getByRole('button', { name: 'Log in…' }).click()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})

test('the demo line opens the screens without reloading: notes written in the demo are still there after Cancel', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  await page.goto('/')
  await page.getByRole('option', { name: /^Groceries/ }).click()
  await page.keyboard.press('Alt+n')
  await page.getByRole('textbox', { name: 'Title' }).fill('Written in the demo')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('option', { name: /^Written in the demo/ })).toBeVisible()
})

test('no shortcut acts behind the log-in screen', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  await page.goto('/')
  const options = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  const before = await options.count()
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  const acted = await page.evaluate(() =>
    [
      new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', altKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
    ].map((e) => (document.dispatchEvent(e), e.defaultPrevented)),
  )
  expect(acted).toEqual([false, false])
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(options).toHaveCount(before)
})

test('Log in can be pressed once: it waits, disabled, while the request runs', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  let prelogins = 0
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await context.route(`${CLOUD}/v1/auth/prelogin`, async (route) => {
    prelogins++
    await held
    await route.fallback()
  })
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  const working = page.getByRole('button', { name: 'Logging in…' })
  await expect(working).toBeDisabled()
  await page.getByLabel('Password').press('Enter')
  await working.click({ force: true }).catch(() => undefined)
  release()
  await expect(page.getByRole('alert')).toHaveText(WRONG_PASSWORD, { timeout: 15_000 })
  expect(prelogins).toBe(1)
})

test('logging in again later from /login reaches the same notes', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  await signUp(page, email)
  await writeNote(page, 'Kept on the server', 'text')
  await page.getByRole('button', { name: `Account, ${email}` }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await logIn(page, email)
  await expect(page.getByRole('option', { name: /^Kept on the server/ })).toBeVisible({ timeout: 15_000 })
})

test('Cancel after the recovery key is accepted ends that recovery session', async ({ page, context, leaks }) => {
  await useCloud(context, leaks)
  const email = newEmail()
  const key = await signUp(page, email)
  const other = await leaks.newContext()
  await useCloud(other, leaks)
  const b = await other.newPage()
  await b.goto('/login')
  await b.getByRole('textbox', { name: 'Email' }).fill(email)
  await b.getByRole('button', { name: 'Use recovery key instead' }).click()
  await b.getByRole('textbox', { name: 'Recovery key, 7 groups of 4' }).fill(key)
  await b.getByRole('button', { name: 'Continue' }).click()
  await expect(b.getByRole('heading', { name: 'Choose a new password' })).toBeVisible({ timeout: 15_000 })
  const loggedOut = b.waitForRequest((r) => r.url().endsWith('/v1/auth/logout') && r.method() === 'POST', { timeout: 5_000 })
  await b.getByRole('button', { name: 'Cancel' }).click()
  await expect(b.getByText("This is a demo. Notes here aren't saved.")).toBeVisible()
  await loggedOut
  // the account's own session (context A) is untouched: it still syncs
  await writeNote(page, 'Still signed in', 'after B gave up')
})
