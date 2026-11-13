// The crypto worker's real key store as a CryptoClient, run in the test's own thread (Node has no worker). Records
// each call by name, so a test can check that a lock called forget, or that nothing derived a key.
import { createKeyring } from '../../../src/worker/keyring.ts'
import type { CryptoClient } from '../../../src/worker/crypto-client.ts'
import type { CryptoOp } from '../../../src/worker/crypto-protocol.ts'

export function keyringCrypto() {
  const keyring = createKeyring()
  const calls: Array<{ op: CryptoOp; args: unknown[] }> = []
  const client = { terminate: () => undefined } as CryptoClient
  for (const op of ['signUpKeys', 'logInKeys', 'unwrap', 'recoveryKeys', 'newPassword', 'seal', 'open', 'forget'] as CryptoOp[]) {
    ;(client as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
      calls.push({ op, args })
      return (keyring[op] as (...a: unknown[]) => Promise<unknown>)(...args)
    }
  }
  return { client, calls, held: () => keyring.held() }
}
