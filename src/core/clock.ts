/** Milliseconds since the epoch. Everything that reads the time takes a Clock, so tests can set it. */
export type Clock = () => number
export const systemClock: Clock = () => Date.now()
