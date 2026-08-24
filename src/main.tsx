import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import './styles.css';
import App from './App';
import { ToastProvider } from './components/Toast';
import { applyAppearance, PreferencesProvider } from './preferences';

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
  <React.StrictMode><BrowserRouter><ToastProvider><PreferencesProvider><App /></PreferencesProvider></ToastProvider></BrowserRouter></React.StrictMode>
);
