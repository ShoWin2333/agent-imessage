export type ChatScope = 'c2c'
export interface ReplyTarget {scope:ChatScope;targetId:string;msgId?:string|undefined;eventId?:string|undefined;forceProactive?:boolean}
