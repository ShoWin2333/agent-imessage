import { expect, it } from 'vitest'
import { sanitizeDetail, withDeadline } from '../src/shared/log.js'

it('redacts credentials and bounds the diagnostic line', () => {
  const bearer = sanitizeDetail(new Error('request failed with Authorization: Bearer abc.def.ghi'))
  expect(bearer).toContain('[redacted]')
  expect(bearer).not.toContain('abc.def.ghi')
  const token = sanitizeDetail(new Error('GET https://api.example.invalid/bot?token=123456:AAH-secret&x=1'))
  expect(token).not.toContain('AAH-secret')
  expect(sanitizeDetail(new Error('x'.repeat(400))).length).toBeLessThanOrEqual(300)
  expect(sanitizeDetail('plain note')).toBe('plain note')
})

it('keeps the error identity and stable code', () => {
  class ProviderError extends Error { code = 'auth' }
  const line = sanitizeDetail(new ProviderError('token rejected'))
  expect(line).toContain('ProviderError')
  expect(line).toContain('[auth]')
})

it('rejects a hanging operation at the deadline and settles a fast one', async () => {
  await expect(withDeadline(new Promise(() => {}), 20, 'test')).rejects.toThrow('test exceeded 20ms')
  await expect(withDeadline(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok')
  await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'test')).rejects.toThrow('boom')
})
