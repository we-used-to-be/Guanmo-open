import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@app-entry'
import './styles/global.css'
import 'katex/dist/katex.min.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
