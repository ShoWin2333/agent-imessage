/**
 * Channel lifecycle vocabulary shared by the Host controller and the settings panel.
 * The panel maps every phase to one localized label; an unknown phase degrades to a
 * neutral "unconfirmed" label instead of guessing a connection state.
 */
export const PHASES = [
  'stopped',
  'starting',
  'listening',
  'retrying',
  'failed',
  'stopping',
  'error',
  'disabled',
  'idle',
] as const

export type Phase = (typeof PHASES)[number]

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value)
}
