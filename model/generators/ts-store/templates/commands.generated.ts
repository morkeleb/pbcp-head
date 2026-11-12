// ts-store: app/(ui)/local/commands.generated.ts, the outbox's commands (what a row asks of the head, by action, and
// the route it goes to) and the outcomes a command comes to (docs/local-first.md "The outbox").

import { CodeGenerator, type RenderContext } from 'clay-generator/types';
import { comment, HEADER, isSpread, type Model, type TypeDef } from '../../lib/model';
import { tsTypes } from '../../lib/ts-types';

export default class extends CodeGenerator {
  render({ data }: RenderContext): string {
    return emit(data as unknown as Model);
  }
}

export function emit(m: Model): string {
  const { object } = tsTypes(m);
  const union = (t: TypeDef) =>
    `${comment(t.doc, '')}export type ${t.name} =\n${t.union!.map((v) => `${comment(v.describe, '  ')}  | {\n${object(v.fields, '      ')}    }`).join('\n')};\n`;
  const command = m.types.find((t) => t.name === 'Command')!;
  const outcome = m.types.find((t) => t.name === 'Outcome')!;
  const routes = command.union!.map((v) => {
    const action = v.fields.find((f) => !isSpread(f) && f.name === 'action');
    const seg = v.route!.split('/').at(-1);
    return `  ${(action as { value: string }).value}: '${seg}',`;
  });
  return `${HEADER('ts-store')}
import type { z } from 'zod';
import type * as Api from '../../../lib/api/schemas.generated';
import type { MeCard } from './model.generated';

type DecisionRequest = z.input<typeof Api.DecisionRequest>;
type SnoozeRequest = z.input<typeof Api.SnoozeRequest>;

${union(command)}
/** The route segment each command is sent to: POST /api/me/cards/{id}/<segment>. */
export const COMMAND_ROUTES = {
${routes.join('\n')}
} as const satisfies Record<Command['action'], string>;

${union(outcome)}`;
}
