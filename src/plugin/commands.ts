import type { NativePreferences } from './bridge.js'

/** Binding commands may use lifecycle operations; the bridge does not parse provider commands. */
export interface BindingCommands {
  matches(text: string): boolean
  run(text: string, scope: {
    sessionId: string | undefined
    preferences: NativePreferences
    reset(): Promise<void>
    resume(): Promise<void>
  }): Promise<{ text: string; preferences?: NativePreferences }>
}
