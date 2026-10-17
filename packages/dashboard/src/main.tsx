import './zod-config.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { dashboardSocketUrl, openBrowserSocket } from './api/browser-socket.js';
import { createClient } from './api/client.js';
import { createDbClient } from './api/db-client.js';
import { openSearchWorker } from './search/browser-worker.js';
import { createWorkerRunner } from './search/runner.js';
import { DbProvider } from './state/DbProvider.js';
import { DeckProvider } from './state/DeckProvider.js';
import type { DeckDeps } from './state/DeckProvider.js';
import { createSessionGuard } from './state/storage.js';
import { App } from './ui/App.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('No #root element');

// Same origin only: the login cookie goes with every call, and the CSP allows nothing else.
const wsUrl = dashboardSocketUrl(location);

const deps: DeckDeps = {
  client: createClient(),
  openSocket: () => openBrowserSocket(wsUrl),
  guard: createSessionGuard(() => sessionStorage),
  reloadPage: () => location.reload(),
  now: Date.now,
};

// The log search runs in a worker so a slow pattern can't freeze the page (BUG-M2-T1).
const search = createWorkerRunner(openSearchWorker);

createRoot(root).render(
  <StrictMode>
    <DeckProvider deps={deps}>
      <DbProvider client={createDbClient()}>
        <App prefs={() => localStorage} search={search} />
      </DbProvider>
    </DeckProvider>
  </StrictMode>,
);
