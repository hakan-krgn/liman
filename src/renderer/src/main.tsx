import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { installRipple } from './ripple'

// Files dropped anywhere outside a drop zone are ignored instead of opened.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

document.documentElement.dataset.platform = window.api.platform
installRipple()

// xterm measures glyphs when it opens, so the font has to be ready first.
void Promise.all([document.fonts.load('14px "JetBrains Mono"'), document.fonts.load('bold 14px "JetBrains Mono"')])
  .catch(() => {})
  .then(() => createRoot(document.getElementById('root')!).render(<App />))
