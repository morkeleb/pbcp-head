// The web brief (CLAUDE.md H2): pages that read and write only through /api/me, like the phone. Every route shares
// one masthead (chrome.tsx); each page fills only the row under its name.

import type { ReactNode } from 'react';
import { ChromeProvider } from './chrome';
import { Announcer } from './components';

export default function UiLayout({ children }: { children: ReactNode }) {
  return (
    <ChromeProvider>
      {children}
      <Announcer />
    </ChromeProvider>
  );
}
