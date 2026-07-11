/**
 * Pipeline stage state machine.
 *
 * Encoded as an explicit adjacency map rather than scattered `if` checks, so
 * the legal-transition set is one readable table and is exhaustively testable.
 * Illegal moves (e.g. rejected → applied) are a domain error, not a UI concern —
 * the board can't be the only thing preventing corrupt history.
 */

export const STAGES = [
  'discovered',
  'interested',
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
] as const;

export type Stage = (typeof STAGES)[number];

export const isStage = (v: string): v is Stage =>
  (STAGES as readonly string[]).includes(v);

/** Terminal stages: nothing leaves them. Reopening means a new Application. */
export const TERMINAL_STAGES: readonly Stage[] = ['rejected', 'withdrawn'];

const TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  discovered: ['interested', 'applied', 'rejected', 'withdrawn'],
  interested: ['applied', 'discovered', 'rejected', 'withdrawn'],
  // Forward progress, plus rejection/withdrawal from any active stage.
  applied: ['screening', 'interview', 'offer', 'rejected', 'withdrawn'],
  screening: ['interview', 'offer', 'rejected', 'withdrawn'],
  interview: ['offer', 'screening', 'rejected', 'withdrawn'],
  offer: ['rejected', 'withdrawn'],
  // Terminal.
  rejected: [],
  withdrawn: [],
};

export function canTransition(from: Stage, to: Stage): boolean {
  if (from === to) return false; // no-op moves are rejected, not silently allowed
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: Stage): readonly Stage[] {
  return TRANSITIONS[from];
}

export const isTerminal = (s: Stage): boolean => TERMINAL_STAGES.includes(s);
