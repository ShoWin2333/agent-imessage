import { randomUUID } from 'node:crypto'
import { DEFAULT_PHOTON_PROJECT_NAME } from './constants.js'
import type { PluginSettings, RouteSettings } from './config.js'
import { normalizeE164 } from './phone.js'
import { normalizePhotonProjectName } from './workspace.js'

export type { RouteSettings }

/** Normalize settings into an explicit routes list, migrating legacy flat fields. */
export function normalizeRoutes(settings: PluginSettings): RouteSettings[] {
  if (Array.isArray(settings.routes) && settings.routes.length > 0) {
    return settings.routes.map(route => normalizeRoute(route))
  }

  const hasLegacy = settings.workspaceCwd !== undefined
    || settings.photonProjectName !== undefined
    || settings.phoneNumber !== undefined
    || settings.assignedPhoneNumber !== undefined
    || settings.photonUserId !== undefined
  if (!hasLegacy) {
    return [createRouteSettings({ photonProjectName: DEFAULT_PHOTON_PROJECT_NAME })]
  }

  return [normalizeRoute({
    id: 'default',
    photonProjectName: settings.photonProjectName ?? DEFAULT_PHOTON_PROJECT_NAME,
    ...(settings.workspaceCwd !== undefined ? { workspaceCwd: settings.workspaceCwd } : {}),
    ...(settings.phoneNumber !== undefined ? { phoneNumber: settings.phoneNumber } : {}),
    ...(settings.assignedPhoneNumber !== undefined
      ? { assignedPhoneNumber: settings.assignedPhoneNumber }
      : {}),
    ...(settings.photonUserId !== undefined ? { photonUserId: settings.photonUserId } : {}),
  })]
}

/** Create one route with a fresh id when omitted. */
export function createRouteSettings(
  input: Partial<RouteSettings> & Pick<RouteSettings, 'photonProjectName'>,
): RouteSettings {
  return normalizeRoute({
    id: input.id ?? randomUUID(),
    photonProjectName: input.photonProjectName,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.workspaceCwd !== undefined ? { workspaceCwd: input.workspaceCwd } : {}),
    ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
    ...(input.assignedPhoneNumber !== undefined
      ? { assignedPhoneNumber: input.assignedPhoneNumber }
      : {}),
    ...(input.photonUserId !== undefined ? { photonUserId: input.photonUserId } : {}),
  })
}

/** Validate and canonicalize one route record. */
export function normalizeRoute(route: RouteSettings): RouteSettings {
  const id = route.id.trim()
  if (id.length === 0) throw new Error('route id is required')
  const photonProjectName = normalizePhotonProjectName(route.photonProjectName)
  const label = route.label?.trim()
  const values = [route.phoneNumber, route.assignedPhoneNumber, route.photonUserId]
  const present = values.filter(value => value !== undefined).length
  if (present !== 0 && present !== values.length) {
    throw new Error('route phoneNumber, assignedPhoneNumber, and photonUserId must be stored together')
  }
  return {
    id,
    photonProjectName,
    ...(label && label.length > 0 ? { label } : {}),
    ...(route.workspaceCwd !== undefined ? { workspaceCwd: route.workspaceCwd } : {}),
    ...(route.phoneNumber !== undefined ? { phoneNumber: normalizeE164(route.phoneNumber) } : {}),
    ...(route.assignedPhoneNumber !== undefined
      ? { assignedPhoneNumber: normalizeE164(route.assignedPhoneNumber) }
      : {}),
    ...(route.photonUserId !== undefined ? { photonUserId: route.photonUserId } : {}),
  }
}

/** Replace or insert one route in a list. */
export function upsertRouteList(routes: RouteSettings[], next: RouteSettings): RouteSettings[] {
  const normalized = normalizeRoute(next)
  const index = routes.findIndex(route => route.id === normalized.id)
  if (index < 0) return [...routes, normalized]
  return routes.map((route, offset) => offset === index ? normalized : route)
}

/** Remove one route by id. */
export function removeRouteFromList(routes: RouteSettings[], routeId: string): RouteSettings[] {
  return routes.filter(route => route.id !== routeId)
}

/** Build the settings document that stores only the routes list. */
export function settingsFromRoutes(routes: RouteSettings[]): PluginSettings {
  return { routes: routes.map(route => normalizeRoute(route)) }
}

/** Display label used when the user did not provide one. */
export function routeDisplayLabel(route: RouteSettings): string {
  if (route.label && route.label.trim().length > 0) return route.label.trim()
  return route.photonProjectName
}
