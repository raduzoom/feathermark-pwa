import { render } from 'preact'
import { systemClock } from './core/clock.ts'
import { Library } from './core/library/library.ts'
import { seedSampleLibrary } from './core/library/sample.ts'
import { createAppModel } from './model/app-model.ts'
import { resumeKept } from './model/session-host.ts'
import './ui/tokens.css'
import './ui/base.css'
import './ui/shell.css'
import './ui/library.css'
import './ui/list.css'
import './ui/editor.css'
import './ui/controls.css'
import './ui/account/account.css'
import { App } from './ui/App.tsx'

// The demo: everything lives in memory and starts over when the tab closes.
const demoLibrary = () => {
  const library = new Library(systemClock)
  seedSampleLibrary(library, systemClock)
  return library
}
const model = createAppModel(demoLibrary())

render(<App model={model} demoLibrary={demoLibrary} />, document.getElementById('app')!)
// with notes kept on this browser, the unlock screen replaces the demo
void resumeKept({ model, demoLibrary }).catch(() => undefined)
