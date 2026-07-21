import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import {installGlobalErrorHandlers, logInfo} from './lib/errorReporting'

installGlobalErrorHandlers()
logInfo('lifecycle', 'renderer boot: main.tsx reached')

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <ErrorBoundary>
            <App/>
        </ErrorBoundary>
    </React.StrictMode>
)
