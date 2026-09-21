/** Build a fetch implementation pinned to one API origin.
 *
 * Same-origin redirects (for example a trailing slash) are followed once.
 * Cross-origin requests and redirects are rejected. Eden maps thrown fetch
 * errors to HTTP 503, which previously surfaced as opaque "Could not …" failures.
 */
export function createSecureFetch(origin: string, implementation: typeof fetch = fetch): typeof fetch {
  const allowed = new URL(origin).origin
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requested = input instanceof Request ? new URL(input.url) : new URL(input.toString(), allowed)
    if (requested.origin !== allowed) throw new Error('refusing cross-origin Photon request')

    const first = await implementation(input, { ...init, redirect: 'manual' })
    const response = await followSameOriginRedirect(first, requested, allowed, implementation, init)
    const finalUrl = response.url || requested.href
    if (new URL(finalUrl).origin !== allowed) {
      throw new Error('refusing cross-origin Photon response')
    }
    return response
  }
}

async function followSameOriginRedirect(
  response: Response,
  requested: URL,
  allowed: string,
  implementation: typeof fetch,
  init?: RequestInit,
): Promise<Response> {
  if (response.status < 300 || response.status >= 400) return response
  const location = response.headers.get('location')
  if (!location) throw new Error('Photon redirect is missing a Location header')
  const next = new URL(location, requested)
  if (next.origin !== allowed) throw new Error('refusing cross-origin Photon redirect')
  try {
    await response.arrayBuffer()
  } catch {
    // Ignore body drain failures on redirect responses.
  }
  // One hop only — refuse further redirects.
  return implementation(next, { ...init, redirect: 'error' })
}
