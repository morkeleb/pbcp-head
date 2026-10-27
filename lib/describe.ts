// RFC §7.5: GET / describes the head.

import { PROTOCOL, type HeadDescription } from '@pbcp/core';
import { RENDERED_TIERS } from './render/mermaid';

/** `seq` is the head's counter: the highest change_seq assigned, 0 before the first (§7.5). */
export function describeHead(owner: string, seq: number): HeadDescription {
  return {
    protocol: PROTOCOL,
    owner,
    seq,
    extensions: ['orders'],
    // §3.1: core and extended are drawn; other types fall back.
    render: { mermaid: [...RENDERED_TIERS] },
  };
}
