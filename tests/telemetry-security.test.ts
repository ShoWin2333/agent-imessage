import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const consumers = ['@photon-ai/otel', '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/instrumentation-undici']

function baggageFor(consumer: string, header: string | string[]) {
  // Resolve from real consumers so hoisted/nested vulnerable copies cannot hide
  // behind a safe top-level dependency.
  const fromConsumer = createRequire(require.resolve(consumer))
  const { W3CBaggagePropagator } = fromConsumer('@opentelemetry/core')
  const api = fromConsumer('@opentelemetry/api')
  const propagator = new W3CBaggagePropagator()
  const context = propagator.extract(api.ROOT_CONTEXT, { baggage: header }, api.defaultTextMapGetter)
  return { api, propagator, context, entries: api.propagation.getBaggage(context)?.getAllEntries() ?? [] }
}

it('preserves ordinary baggage values and metadata in every telemetry consumer', () => {
  for (const consumer of consumers) {
    const { api, propagator, context, entries } = baggageFor(consumer, 'team=synthetic,place=hello%20world;tag')
    expect(entries.map(([key, value]: [string, { value: string }]) => [key, value.value])).toEqual([['team', 'synthetic'], ['place', 'hello world']])
    const carrier: Record<string, string> = {}
    propagator.inject(context, carrier, api.defaultTextMapSetter)
    expect(carrier.baggage).toBe('team=synthetic,place=hello%20world;tag')
  }
})

it('bounds inbound baggage entries, aggregate size and individual entries for string and array headers', () => {
  for (const consumer of consumers) {
    const many = Array.from({ length: 500 }, (_, i) => `key${i}=synthetic`)
    for (const header of [many.join(','), many]) expect(baggageFor(consumer, header).entries).toHaveLength(180)
    const large = Array.from({ length: 10 }, (_, i) => `key${i}=${'a'.repeat(2000)}`)
    for (const header of [large.join(','), large]) expect(baggageFor(consumer, header).entries).toHaveLength(4)
    for (const header of [`huge=${'a'.repeat(4096)},small=valid`, [`huge=${'a'.repeat(4096)}`, 'small=valid']]) {
      expect(baggageFor(consumer, header).entries).toEqual([['small', { value: 'valid' }]])
    }
  }
})

it('exports synthetic Photon traces, logs and metrics to an isolated loopback collector', async () => {
  const requests: Array<{ path: string; body: string }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString() })
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}')
  })
  // Inherited collector configuration must never redirect this offline test.
  for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_')) vi.stubEnv(key, undefined)
  let runtime: { shutdown(): Promise<void> } | undefined
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const { setupOtel } = await import('@photon-ai/otel')
    const handle = setupOtel({ serviceName: 'security-fixture', endpoint: `http://127.0.0.1:${address.port}`, register: false, instrumentFetch: false, logLevel: 'silent' })
    runtime = handle
    handle.tracerProvider.getTracer('fixture').startSpan('fixture-span').end()
    handle.loggerProvider.getLogger('fixture').emit({ body: 'fixture-log' })
    handle.getMeter('fixture').createCounter('fixture-counter').add(1)
    await handle.shutdown(); runtime = undefined
    expect(requests.find(r => r.path === '/v1/traces')?.body).toContain('fixture-span')
    expect(requests.find(r => r.path === '/v1/logs')?.body).toContain('fixture-log')
    expect(requests.find(r => r.path === '/v1/metrics')?.body).toContain('fixture-counter')
  } finally {
    await runtime?.shutdown()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    vi.unstubAllEnvs()
  }
})
