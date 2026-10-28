// RFC §7.5: GET / describes the head.

import { PROTOCOL, type HeadDescription } from '@pbcp/core';
import { RENDERED_TIERS } from './render/mermaid';

/**
 * `seq` is the head's counter: the highest change_seq assigned, 0 before the first (§7.5). `api` is where the producer
 * operations are: this head serves them under /api, so a producer configured with only the origin finds them (§7.5,
 * 0.7: a head MAY give `api`; a client that reads it sends its operations there).
 */
export function describeHead(owner: string, seq: number, api?: string): HeadDescription {
  return {
    protocol: PROTOCOL,
    owner,
    ...(api ? { api } : {}),
    seq,
    extensions: ['orders'],
    // §3.1: core and extended are drawn; other types fall back.
    render: { mermaid: [...RENDERED_TIERS] },
  };
}
