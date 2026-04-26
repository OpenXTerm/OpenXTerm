import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'

import { App } from './App'
import { RemoteEntryPropertiesWindowPage } from './components/workspace/RemoteEntryPropertiesWindowPage'
import { TransferWindowPage } from './components/workspace/TransferWindowPage'
import './index.css'

document.documentElement.classList.toggle('platform-macos', navigator.userAgent.includes('Mac'))
document.documentElement.classList.toggle('runtime-tauri', '__TAURI_INTERNALS__' in window)

const isTransferWindow = new URLSearchParams(window.location.search).get('transfer-window') === '1'
const isRemotePropertiesWindow = new URLSearchParams(window.location.search).get('remote-properties-window') === '1'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isRemotePropertiesWindow ? <RemoteEntryPropertiesWindowPage /> : isTransferWindow ? <TransferWindowPage /> : <App />}
  </React.StrictMode>,
)
