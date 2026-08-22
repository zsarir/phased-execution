import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { createQueryClient } from './lib/queries';
import { applyDensity, applyTheme, getPrefs } from './lib/prefs';
import './styles/theme.css';

// Before React renders, not inside it: a theme applied in an effect means the
// first paint is the wrong one and the app flashes Night at someone who chose
// Paper. `theme.css` declares both grounds, so this attribute is the whole
// switch and it costs one DOM write.
applyTheme(getPrefs().theme);
applyDensity(getPrefs().density);

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
