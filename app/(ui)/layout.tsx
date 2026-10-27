// The web brief (CLAUDE.md H2): pages that read and write only through /api/me, like the phone.

import type { ReactNode } from 'react';
import { Announcer, Nav } from './components';

export default function UiLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      {children}
      <Announcer />
    </>
  );
}
