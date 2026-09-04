import React, { useLayoutEffect } from 'react'
import ReactDOM from 'react-dom/client'
import WebApp from './WebApp'
import './styles/global.css'
import './styles/tokens/official-light.css'
import './styles/startupShell.css'

function WebRoot() {
  useLayoutEffect(() => {
    document.getElementById('guanmo-startup-shell')?.remove()
  }, [])
  return <WebApp />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebRoot />
  </React.StrictMode>,
)
