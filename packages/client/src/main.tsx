import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { NetworkProvider } from './contexts/NetworkContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ToastProvider } from './contexts/ToastContext'
import { ReauthProvider } from './components/ReauthProvider'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <NetworkProvider>
          <AuthProvider>
            <ReauthProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ReauthProvider>
          </AuthProvider>
        </NetworkProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
)