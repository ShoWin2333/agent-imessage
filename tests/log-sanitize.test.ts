import { expect, it } from 'vitest'
import { sanitizeDetail, withDeadline } from '../src/shared/log.js'

it('does not serialize provider text, headers, JSON credential fields or arbitrary objects', () => {
  for (const detail of [
    new Error('Authorization: Bearer SYNTHETIC_BEARER'),
    new Error('Authorization: QQBot SYNTHETIC_QQ_TOKEN'),
    new Error('{"appSecret":"SYNTHETIC_SECRET","access_token":"SYNTHETIC_TOKEN"}'),
    new Error('https://provider.invalid/bot1234:SYNTHETIC_TOKEN/path'),
    { appSecret: 'SYNTHETIC_SECRET', access_token: 'SYNTHETIC_TOKEN' },
    'SYNTHETIC_PRIVATE_MESSAGE', undefined, Symbol('SYNTHETIC_SECRET'),
  ]) {
    const line = sanitizeDetail(detail)
    expect(line).not.toContain('SYNTHETIC')
    expect(line.length).toBeLessThanOrEqual(160)
  }
})

it('keeps only the error identity and a bounded system code', () => {
  class ProviderError extends Error { code = 'ETIMEDOUT' }
  expect(sanitizeDetail(new ProviderError('private detail'))).toBe('ProviderError[ETIMEDOUT]')
  expect(sanitizeDetail(Object.assign(new Error('private'), { code: 401 }))).toBe('Error[401]')
  expect(sanitizeDetail(Object.assign(new Error('private'), { code: 'SYNTHETIC_SECRET' }))).toBe('Error')
})

it('rejects a hanging operation at the deadline and settles a fast one', async () => {
  await expect(withDeadline(new Promise(() => {}), 20, 'test')).rejects.toThrow('test exceeded 20ms')
  await expect(withDeadline(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok')
  await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'test')).rejects.toThrow('boom')
})
