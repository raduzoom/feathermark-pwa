// The password rule every screen and the account service share (AccountFlows.swift PasswordStrength). Its own module,
// with no imports, so the log-in and create-account screens can use it in the first load without pulling in the
// account service (and with it the API client).

/** The minimum, in code points after NFC. */
export const MIN_PASSWORD = 10

const codePoints = (password: string): number => [...password.normalize('NFC')].length

export const passwordLongEnough = (password: string): boolean => codePoints(password) >= MIN_PASSWORD

export type PasswordStrength = 'tooShort' | 'fair' | 'good' | 'strong'

/** Under 10 code points too short, then fair; good from 12, strong from 16. */
export function passwordStrength(password: string): PasswordStrength {
  const n = codePoints(password)
  return n < MIN_PASSWORD ? 'tooShort' : n < 12 ? 'fair' : n < 16 ? 'good' : 'strong'
}

/** The label beside the password field; none while too short. */
export const strengthLabel: Record<PasswordStrength, string | null> = { tooShort: null, fair: 'Fair', good: 'Good', strong: 'Strong' }
