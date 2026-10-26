// The gate (CLAUDE.md, milestone H1): the conformance suite from @pbcp/core/conformance over HTTP against
// this head on local Postgres. C01–C15, C21, C22 at MUST and C24 at SHOULD, as shipped (page cap 200) and
// again with a page cap of 2 so §7.2 paging is exercised on every fixture.
//
// R01–R08 run against the reference classifier from @pbcp/core's conformance/in-process, which the package
// does not export (nor build); it is imported from the vendored source. The head's own rendering pipeline is
// milestone H2 and will replace it here.

import { conformanceSuite } from '@pbcp/core/conformance/vitest';
import { describe, inject } from 'vitest';
import { referenceRenderer } from '../../vendor/pbcp/packages/core/conformance/in-process/render';
import { testDb } from '../http/helpers';
import { httpHead } from './http-head';

const head = (pageSize?: number) => () => httpHead({ baseUrl: inject('headUrl'), db: testDb(), ...(pageSize ? { pageSize } : {}) });

describe('HTTP head, page cap 200', () => {
  conformanceSuite({ head: head() });
});

describe('HTTP head, page cap 2', () => {
  conformanceSuite({ head: head(2) });
});

describe('reference classifier (in-process, until the H2 rendering pipeline)', () => {
  conformanceSuite({ render: () => referenceRenderer() });
});
