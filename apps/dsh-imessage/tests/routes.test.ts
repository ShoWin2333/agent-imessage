import { describe, expect, it } from 'vitest'
import {
  createRouteSettings,
  normalizeRoutes,
  removeRouteFromList,
  settingsFromRoutes,
  upsertRouteList,
} from '../src/routes.js'

describe('route settings helpers', () => {
  it('migrates legacy flat settings into a default route', () => {
    expect(normalizeRoutes({
      workspaceCwd: '/tmp/a',
      photonProjectName: 'dsh-a',
      phoneNumber: '+14155552671',
      assignedPhoneNumber: '+14155550000',
      photonUserId: 'user-1',
    })).toEqual([{
      id: 'default',
      workspaceCwd: '/tmp/a',
      photonProjectName: 'dsh-a',
      phoneNumber: '+14155552671',
      assignedPhoneNumber: '+14155550000',
      photonUserId: 'user-1',
    }])
  })

  it('upserts and removes routes while persisting only the routes list', () => {
    const first = createRouteSettings({
      id: 'one',
      label: 'Alpha',
      photonProjectName: 'dsh-a',
      workspaceCwd: '/tmp/a',
    })
    const second = createRouteSettings({
      id: 'two',
      photonProjectName: 'dsh-b',
      workspaceCwd: '/tmp/b',
    })
    const routes = upsertRouteList(upsertRouteList([], first), second)
    expect(settingsFromRoutes(routes)).toEqual({ routes })
    expect(removeRouteFromList(routes, 'one')).toEqual([second])
  })
})
