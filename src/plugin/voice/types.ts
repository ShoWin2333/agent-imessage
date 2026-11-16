/** One inbound audio clip; bytes stay in memory for the single upstream call. */
export interface AudioClip {
  /** Basename only. */
  name: string
  mimeType: string
  bytes: Buffer
}

/** Deployment-level speech settings, shared by every channel binding. */
export interface VoiceSettings {
  replyMode?: 'text' | 'voice' | undefined
  enabled: boolean
  /** Credentials reference holding the provider API key. */
  credentialRef: string
  /** API prefix such as `https://api.openai.com/v1`, without a trailing slash. */
  baseURL: string
  /** Audio understanding model. */
  model: string
  /** Speech model on the same configured provider; defaults for older saved configs. */
  speechModel?: string | undefined
  /** Reply voice name. */
  voice: string
  /** Optional system instruction; empty sends none. */
  instructions: string
}

/** One synthesized answer plus the text the model produced with it. */
export interface VoiceReply {
  audio: Buffer
  name: string
  mimeType: string
  text: string
}
