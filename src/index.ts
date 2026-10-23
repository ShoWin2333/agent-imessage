/** DeepSeek Harness channel plugin; DSH owns all agent execution. */
export { apply, name, inject, Config } from './plugin/index.js'
export type { Binding } from './plugin/index.js'
export type { ChannelAdapter, ChannelMessage, ChannelConnection, ChannelFactory } from './channels/types.js'
// Adapters are exported as types only. The Host entry imports each implementation on
// demand, so a Telegram-only deployment never loads Discord or Spectrum.
export type { IMessageAdapter } from './channels/imessage.js'
export type { TelegramAdapter } from './channels/telegram.js'
export type { WeixinAdapter } from './channels/weixin.js'
export type { DiscordAdapter } from './channels/discord.js'

export { ChannelsController } from './plugin/management.js'
