// The crypto worker's key store, run in Node: the keys stay in it, sessions open what other sessions sealed,
// and forget drops keys.
import { expect, test } from 'vitest'
import { toHex } from '../../src/core/bytes.ts'
import { CryptoError } from '../../src/core/crypto/errors.ts'
import { parseRecoveryKey } from '../../src/core/crypto/recovery.ts'
import { createKeyring } from '../../src/worker/keyring.ts'

const ID = '01JC8ZQ6V4N1XG2H3K5M7P9R0T'
const PASSWORD = 'correct horse battery staple'
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const bytes = (s: string) => new TextEncoder().encode(s)

const sealBoth = (k: ReturnType<typeof createKeyring>, session: number) =>
  k.seal(session, [
    { plain: bytes('title'), part: 'metadata', id: ID },
    { plain: bytes('body'), part: 'noteBody', id: ID },
  ])
const openBoth = async (k: ReturnType<typeof createKeyring>, session: number, envelopes: Uint8Array[]) =>
  (await k.open(session, [
    { envelope: envelopes[0]!, part: 'metadata', id: ID },
    { envelope: envelopes[1]!, part: 'noteBody', id: ID },
  ])).map((r) => (r instanceof Uint8Array ? text(r) : r))

test('sign up, log in, recover and change the password: every session opens what the first sealed', async () => {
  const k = createKeyring()
  const up = await k.signUpKeys(PASSWORD)
  expect(up.salt.length).toBe(16)
  expect(up.kdf).toEqual({ alg: 'argon2id13', t: 3, m_kib: 262144, p: 1 })
  expect([up.authKey.length, up.recoveryAuthKey.length, up.wrappedPassword.length, up.wrappedRecovery.length]).toEqual([32, 32, 74, 74])
  expect(up.recoveryText).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/)
  // Only what the server gets, the recovery text to show once, and a handle: no master, root, kek or recovery key.
  expect(Object.keys(up).sort()).toEqual(['authKey', 'kdf', 'recoveryAuthKey', 'recoveryText', 'salt', 'session', 'wrappedPassword', 'wrappedRecovery'])
  expect(typeof up.session).toBe('number')
  const sealed = await sealBoth(k, up.session)

  const login = await k.logInKeys(PASSWORD, up.salt, up.kdf)
  expect(toHex(login.authKey)).toBe(toHex(up.authKey))
  const { session } = await k.unwrap(up.wrappedPassword, login.kek, 'password')
  expect(session).not.toBe(up.session)
  expect(await openBoth(k, session, sealed)).toEqual(['title', 'body'])

  const rec = await k.recoveryKeys(up.recoveryText.toLowerCase())
  expect(toHex(rec.recoveryAuthKey)).toBe(toHex(up.recoveryAuthKey))
  const recovered = await k.unwrap(up.wrappedRecovery, rec.kek, 'recovery')
  expect(await openBoth(k, recovered.session, sealed)).toEqual(['title', 'body'])

  const changed = await k.newPassword(recovered.session, 'another password entirely')
  expect(toHex(changed.salt)).not.toBe(toHex(up.salt))
  const again = await k.logInKeys('another password entirely', changed.salt, changed.kdf)
  expect(toHex(again.authKey)).toBe(toHex(changed.authKey))
  const third = await k.unwrap(changed.wrappedPassword, again.kek, 'password')
  expect(await openBoth(k, third.session, sealed)).toEqual(['title', 'body'])
}, 30_000)

test('a wrong password, wrong kind and a typo fail with their kinds; open reports per item', async () => {
  const k = createKeyring()
  const up = await k.signUpKeys(PASSWORD)
  const wrong = await k.logInKeys('not the password', up.salt, up.kdf)
  await expect(k.unwrap(up.wrappedPassword, wrong.kek, 'password')).rejects.toEqual(new CryptoError('authentication'))
  const right = await k.logInKeys(PASSWORD, up.salt, up.kdf)
  await expect(k.unwrap(up.wrappedPassword, right.kek, 'recovery')).rejects.toBeInstanceOf(CryptoError)
  await expect(k.recoveryKeys('DT1H-530K')).rejects.toEqual(new CryptoError('typo'))

  const [good] = await k.seal(up.session, [{ plain: bytes('x'), part: 'metadata', id: ID }])
  const results = await k.open(up.session, [
    { envelope: good!, part: 'metadata', id: ID },
    { envelope: good!, part: 'noteBody', id: ID },
    { envelope: good!.subarray(0, 40), part: 'metadata', id: ID },
  ])
  expect(results).toEqual([bytes('x'), { error: 'authentication' }, { error: 'malformed' }])
}, 30_000)

test('forget drops the master key and every kek handle the session made; a kek handle can be forgotten alone', async () => {
  const k = createKeyring()
  const up = await k.signUpKeys(PASSWORD)
  const login = await k.logInKeys(PASSWORD, up.salt, up.kdf)
  const { session } = await k.unwrap(up.wrappedPassword, login.kek, 'password')
  const spare = await k.logInKeys(PASSWORD, up.salt, up.kdf)
  expect(k.held()).toEqual({ sessions: 2, keks: 2 })

  await k.forget(session)
  expect(k.held()).toEqual({ sessions: 1, keks: 1 })
  await expect(k.seal(session, [])).rejects.toBeInstanceOf(TypeError)
  await expect(k.unwrap(up.wrappedPassword, login.kek, 'password')).rejects.toBeInstanceOf(TypeError)

  await k.forget(spare.kek)
  await k.forget(up.session)
  expect(k.held()).toEqual({ sessions: 0, keks: 0 })
  await k.forget(up.session) // forgetting twice is fine
}, 30_000)

test('forget wipes the key bytes it drops', async () => {
  const kept: Uint8Array[] = []
  const k = createKeyring({ onKey: (key) => kept.push(key) })
  const up = await k.signUpKeys(PASSWORD)
  const login = await k.logInKeys(PASSWORD, up.salt, up.kdf)
  const { session } = await k.unwrap(up.wrappedPassword, login.kek, 'password')
  expect(kept.length).toBe(3) // two master keys, one kek
  expect(kept.every((key) => key.some((b) => b !== 0))).toBe(true)
  await k.forget(session)
  await k.forget(up.session)
  expect(kept.every((key) => key.every((b) => b === 0))).toBe(true)
}, 30_000)

test('the wrapped keys carry their kind bytes, and the recovery text parses', async () => {
  const k = createKeyring()
  const up = await k.signUpKeys(PASSWORD)
  expect([up.wrappedPassword[0], up.wrappedPassword[1], up.wrappedRecovery[0], up.wrappedRecovery[1]]).toEqual([1, 1, 1, 2])
  expect(parseRecoveryKey(up.recoveryText).length).toBe(16)
}, 30_000)
