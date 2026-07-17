/**
 * Shared error type for every state-machine transition guard in
 * `src/domain/` (`commandState.ts`, D-P2-2; `outboxState.ts`, D-P2-3) and,
 * per the Phase 2 plan (D-P2-10), later `src/store/commandStore.ts` /
 * `outboxStore.ts`, which re-enforce the same transitions just before
 * persisting a status change. Kept in exactly one place so every "illegal
 * transition" failure anywhere in the bridge has the same shape and can be
 * told apart from an ordinary `Error` via `instanceof`.
 *
 * No IO, no imports: this is the most foundational file in `src/domain/`.
 * `machine`/`from`/`to` are plain `string`, not `CommandStatus`/
 * `OutboxStatus`, specifically so this module never needs to import either
 * status machine (or, later, any store) and stays free of import cycles.
 */
export class IllegalTransitionError extends Error {
  readonly machine: string;
  readonly from: string;
  readonly to: string;

  constructor(machine: string, from: string, to: string) {
    super(`illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}
