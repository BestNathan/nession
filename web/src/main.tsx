import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
import App from './App.tsx'
import { initExtensions } from './extensions/registry'
import './index.css'
import { useMediaQuery } from './hooks/useMediaQuery'

function Root() {
  // Mobile browser bottom bar + terminal BottomBar sheet can cover a
  // bottom-right toast; move toasts to top-center on small screens.
  const isMobile = useMediaQuery('(max-width: 767px)')
  return (
    <>
      <App />
      <Toaster position={isMobile ? 'top-center' : 'bottom-right'} richColors />
    </>
  )
}

// Initialize extensions before first render.
// Extensions are discovered from web/src/extensions/*/
initExtensions().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  )
})
