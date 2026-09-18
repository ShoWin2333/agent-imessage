/** Provider-neutral tool schemas. All execution and ownership checks live in GatewayRouter. */
export const gatewayTools = [
  ...['send_imessage_file', 'send_imessage_voice'].map(name => ({
    type: 'function', name, deferLoading: false,
    description: `Send an existing ${name.endsWith('voice') ? 'audio file as native voice' : 'file or image'} from the current workspace to the initiating conversation. Only use when requested by the user.`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  })),
  { type: 'function', name: 'ask_imessage_user', deferLoading: false, description: 'Ask the user a question and wait for their answer over the current message channel.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } },
]
