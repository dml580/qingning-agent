import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WorkbenchProvider } from './context/WorkbenchContext'
import { applyTheme, readTheme } from './theme'
import './index.css'

applyTheme(readTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkbenchProvider>
      <App />
    </WorkbenchProvider>
  </StrictMode>,
)
