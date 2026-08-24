import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import './styles.css';
import App from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './components/Toast';
import { applyAppearance } from './preferences';

const storedAppearance = localStorage.getItem('backmygit-appearance');
const legacyTheme = localStorage.getItem('backmygit-theme');
applyAppearance(
  storedAppearance === 'dark' || storedAppearance === 'light' || storedAppearance === 'system'
    ? storedAppearance
    : legacyTheme === 'dark'
      ? 'dark'
      : legacyTheme === 'light'
        ? 'light'
        : 'system',
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider></BrowserRouter></React.StrictMode>
);
