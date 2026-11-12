import { render } from 'preact'
import './ui/tokens.css'
import './ui/base.css'
import './ui/shell.css'
import { App } from './ui/App.tsx'

render(<App />, document.getElementById('app')!)
