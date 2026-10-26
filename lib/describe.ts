// RFC §7.5: GET / describes the head.

import { PROTOCOL, type HeadDescription } from '@pbcp/core';

export function describeHead(owner: string): HeadDescription {
  return {
    protocol: PROTOCOL,
    owner,
    // The orders extension is milestone H3.
    extensions: [],
    // Rendering is milestone H2; until then this head draws no mermaid tier and says so.
    render: { mermaid: [] },
  };
}
