export const STATES = ['idle', 'working', 'blocked', 'not-running'] as const;
export type State = typeof STATES[number];
export function decideTransition(from: State, _to: State): boolean {
  return from !== 'not-running';
}
