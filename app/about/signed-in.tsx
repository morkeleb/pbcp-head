'use client';

// A visitor already signed in on this device goes on to the brief: the session lives in this browser's storage
// (app/(ui)/client.ts), so the server cannot know it, and the front door itself never shows a signed-in thing.

import { useEffect } from 'react';
import { loadTokens } from '../(ui)/client';

export function SignedIn() {
  useEffect(() => {
    if (loadTokens()) location.replace('/brief');
  }, []);
  return null;
}
