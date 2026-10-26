// RFC §7.5: GET / describes the head.

import { PROTOCOL, type HeadDescription } from '@pbcp/core';
import { RENDERED_TIERS } from './render/mermaid';

export function describeHead(owner: string): HeadDescription {
  return {
    protocol: PROTOCOL,
    owner,
    // The orders extension is milestone H3.
    extensions: [],
    // §3.1: core and extended are drawn; other types fall back.
    render: { mermaid: [...RENDERED_TIERS] },
    // TODO(pbcp-0.4): @pbcp/core 0.4 adds `seq` to the description (the head's current change_seq).
  };
}
