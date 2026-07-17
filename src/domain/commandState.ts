/**
 * Command state machine (decision D-P2-2, Phase 2 subset). Pure domain: no
 * IO. `src/store/commandStore.ts` (Task 6) re-enforces these exact
 * transitions just before persisting `commands.status`, so this map is the
 * single source of truth for which edges are legal anywhere in the bridge.
 *
 * SYSTEM_ECHO and REJECTED are terminal BY DESIGN: an echo of our own
 * outbound mail (D-P2-4, control C3) or a gate rejection (identity C1 /
 * time-window / missing Message-ID) never legitimately leads anywhere else.
 * READY_FOR_DISPATCH also has an empty outgoing-edge list below, but for a
 * DIFFERENT reason — it is Phase 2's frontier, not conceptually terminal.
 * Phase 3 extends the machine past it (dispatch/execution/reply states) via
 * a new decision/ADR; those edges are deliberately NOT added here (YAGNI).
 */
import { IllegalTransitionError } from './errors.js';

export type CommandStatus =
  | 'RECEIVED'
  | 'SYSTEM_ECHO'
  | 'REJECTED'
  | 'QUEUED_WINDOW'
  | 'READY_FOR_DISPATCH';

export const COMMAND_STATUSES: readonly CommandStatus[] = [
  'RECEIVED',
  'SYSTEM_ECHO',
  'REJECTED',
  'QUEUED_WINDOW',
  'READY_FOR_DISPATCH',
];

/**
 * Legal outgoing edges per status (D-P2-2). An empty array means "no legal
 * outgoing edge from here" — see the module doc comment above for why that
 * means two different things for SYSTEM_ECHO/REJECTED versus
 * READY_FOR_DISPATCH.
 */
export const COMMAND_TRANSITIONS: Readonly<Record<CommandStatus, readonly CommandStatus[]>> = {
  RECEIVED: ['SYSTEM_ECHO', 'REJECTED', 'QUEUED_WINDOW', 'READY_FOR_DISPATCH'],
  SYSTEM_ECHO: [],
  REJECTED: [],
  QUEUED_WINDOW: ['READY_FOR_DISPATCH'],
  READY_FOR_DISPATCH: [],
};

/**
 * Throws `IllegalTransitionError` unless `to` is one of `from`'s legal edges
 * in `COMMAND_TRANSITIONS`. There is no separate notion of "terminal" here
 * beyond the map: a status whose array is empty simply has no legal `to`,
 * for any `to` including itself (D-P2-2 lists no self-transitions, so every
 * self-transition throws too).
 */
export function assertCommandTransition(from: CommandStatus, to: CommandStatus): void {
  if (!COMMAND_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError('command', from, to);
  }
}
