import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { normalizeTenantPath, siteContext } from './lib/util';
import './index.css';

registerSW({ immediate: true });

// Restaurant pages live under /r/<slug>. Making that prefix the router basename keeps every in-app path
// (`/dashboard/orders`, `/login`, `/t/<token>`, `/order/<id>`) unchanged: links, redirects, back/forward and
// deep-link reloads all stay inside the same restaurant automatically.
normalizeTenantPath();
const { basename } = siteContext();
// Installed app (PWA) of a path-based restaurant opens that restaurant, not the platform (served by the API).
if (basename && import.meta.env.PROD) document.querySelector('link[rel="manifest"]')?.setAttribute('href', `${basename}/manifest.webmanifest`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename || undefined} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
