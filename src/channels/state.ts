/** Transport cursors only; execution and session history belong to DSH. */
export interface RouteState { seen: string[]; channelCursor?: string; weixinContext?: string }
export interface WeixinCredential { token: string; accountId: string; ownerUserId: string; baseUrl: string }
