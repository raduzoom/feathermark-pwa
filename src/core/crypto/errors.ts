/**
 * A caller's own mistake (id text that is not a ULID, a key of the wrong length, unsupported parameters):
 * rejected before any crypto runs (crypto.md, "Errors"). A TypeError, the language's invalid-argument error.
 */
export class InvalidArgument extends TypeError {
  override name = 'InvalidArgument'
}

/** The three kinds of failure on data from a server, a file or the user (crypto.md, "Errors"). */
export type CryptoErrorKind = 'authentication' | 'malformed' | 'typo'

export class CryptoError extends Error {
  override name = 'CryptoError'
  readonly kind: CryptoErrorKind
  constructor(kind: CryptoErrorKind, message: string = kind) {
    super(message)
    this.kind = kind
  }
}

export const CRYPTO_ERROR_KINDS: readonly CryptoErrorKind[] = ['authentication', 'malformed', 'typo']

/** Throws InvalidArgument unless `bytes` is a Uint8Array of `length` bytes. */
export function requireBytes(bytes: unknown, length: number, what: string): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new InvalidArgument(`${what} must be ${length} bytes`)
}

/** Fresh bytes from the platform CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}
