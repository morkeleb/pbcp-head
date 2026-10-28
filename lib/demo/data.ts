// What `pnpm demo` seeds, in one place for it, for `pnpm demo:purge` and for the front door's demo brief (lib/demo): the producer roots it mints tokens for (each
// with instance `demo`), the namespace of every card it puts (`<root>:demo:…`), and the line every demo order carries.

import type { Urgency } from '@pbcp/core';

export const DEMO_ROOTS = {
  cal: { ceiling: 'immediate' },
  goalpath: { ceiling: 'immediate' },
  hermes: { executor: true },
  mail: {},
  n8n: {},
  obsidian: {},
  todoist: { executor: true },
} as const satisfies Record<string, { ceiling?: Urgency; executor?: boolean }>;

export type DemoRoot = keyof typeof DEMO_ROOTS;

/** The instance of every demo token, so a real producer's token on the same root is told apart. */
export const DEMO_INSTANCE = 'demo';
/** The namespace of every card the demo puts (`goalpath:demo:…`). */
export const DEMO_NAMESPACE = 'demo';
/** In the body of every order the demo gives: how its orders, and the executors' cards in their threads, are found. */
export const DEMO_MARK = '_Example data (pnpm demo)._';
