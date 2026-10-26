// RenderUnderTest (from @pbcp/core/conformance) for this head's rendering pipeline (lib/render): the same
// function a PUT runs after commit, with the real mermaid renderer and the Postgres diagram cache.
//
//   reset   empty the diagram cache, zero the draw counter
//   render  the body through the pipeline; the result is the classification the fixtures check
//   draws   diagrams actually drawn since reset (cache misses)

import type { RenderUnderTest } from '@pbcp/core/conformance';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { drawCount, renderBody, resetDrawCount } from '../../lib/render';

export function pipelineRenderer(db: Db): RenderUnderTest {
  return {
    async reset() {
      await db.execute(sql`truncate diagrams`);
      resetDrawCount();
    },
    async render(body) {
      return (await renderBody(db, body)).result;
    },
    async draws() {
      return drawCount();
    },
  };
}
