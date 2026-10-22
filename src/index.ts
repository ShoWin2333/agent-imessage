/** DeepSeek Harness channel plugin; DSH owns all agent execution. */
export { apply, name, inject, Config } from './plugin/index.js'
export type { Binding } from './plugin/index.js'
export type { ChannelAdapter, ChannelMessage, ChannelConnection, ChannelFactory } from './channels/types.js'
export { IMessageAdapter } from './channels/imessage.js'
export { TelegramAdapter } from './channels/telegram.js'
export { WeixinAdapter } from './channels/weixin.js'
export { DiscordAdapter } from './channels/discord.js'

export { ChannelsController } from './plugin/management.js'
