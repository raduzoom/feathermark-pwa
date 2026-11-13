// The page's route as a signal (src/model/route.ts says which screen a path shows). Moving between the demo and the
// account screens never reloads the page, so notes written in the demo are still there to offer to the account.
import { signal, type ReadonlySignal } from '@preact/signals'
import { parseRoute, type Route } from '../model/route.ts'

const accounts = Boolean(import.meta.env.VITE_FEATHER_CLOUD_URL)
const read = (): Route => parseRoute(location.pathname, location.search, accounts)
const current = signal<Route>(read())
export const route: ReadonlySignal<Route> = current

addEventListener('popstate', () => (current.value = read()))

export function navigate(path: string, o?: { replace?: boolean }): void {
  if (o?.replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  current.value = read()
}
