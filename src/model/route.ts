// Which screen a path shows. With accounts on, /login is the log-in screen and /login?create the create-account
// screen (the demo line's buttons; returning users go straight to /login). Without accounts every path is the demo.
export type Route = 'app' | 'login' | 'create'

export function parseRoute(pathname: string, search: string, accounts: boolean): Route {
  if (!accounts || pathname.replace(/\/+$/, '') !== '/login') return 'app'
  return new URLSearchParams(search).has('create') ? 'create' : 'login'
}
