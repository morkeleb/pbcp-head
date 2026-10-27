// The gate (CLAUDE.md, milestone H1): the conformance suite from @pbcp/core/conformance over HTTP against
// this head on local Postgres: every core fixture, and the orders extension's (C16–C20, C32, C33) with
// extensions: ['orders'], as shipped (page cap 200) and
// again with a page cap of 2 so §7.2 paging is exercised on every fixture.
//
// R01–R08 run against the head's own rendering pipeline (lib/render): markdown, sanitising, mermaid drawn
// in headless Chromium, the Postgres diagram cache. Rendering conformance is tested from bodies, not over
// HTTP (RFC §14).

import { conformanceSuite } from '@pbcp/core/conformance/vitest';
import { afterAll, describe, inject } from 'vitest';
import { closeBrowser } from '../../lib/render/draw';
import { testDb } from '../http/helpers';
import { httpHead } from './http-head';
import { pipelineRenderer } from './render-head';

const head = (pageSize?: number) => () => httpHead({ baseUrl: inject('headUrl'), db: testDb(), ...(pageSize ? { pageSize } : {}) });

describe('HTTP head, page cap 200', () => {
  conformanceSuite({ head: head(), extensions: ['orders'] });
});

describe('HTTP head, page cap 2', () => {
  conformanceSuite({ head: head(2), extensions: ['orders'] });
});

describe('rendering pipeline', () => {
  conformanceSuite({ render: () => pipelineRenderer(testDb()) });
  afterAll(() => closeBrowser());
});
