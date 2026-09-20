import type { AppConfig, Secrets } from './config.js'
import { routeChannels, photonSecretKey } from '../gateway/config.js'

/** Retain prepared Photon resources when an Agent is unbound or removed. */
export function photonAccounts(config: AppConfig, secrets: Secrets): NonNullable<Secrets['photonAccounts']> {
  const accounts = {...secrets.photonAccounts}
  for (const route of config.routes) for (const channel of routeChannels(route)) {
    if (channel.kind !== 'imessage') continue
    const secret = secrets.photon[photonSecretKey(route,channel)] || accounts[channel.projectId]?.secret || process.env[channel.projectSecretEnv]
    if (secret) accounts[channel.projectId] = {secret,assignedPhoneNumber:channel.assignedPhoneNumber,senderPhoneNumber:channel.senderPhoneNumber}
  }
  return accounts
}
export function publicPhotonAccounts(config: AppConfig, secrets: Secrets) {
  return Object.entries(photonAccounts(config,secrets)).map(([projectId,{assignedPhoneNumber,senderPhoneNumber}])=>({projectId,assignedPhoneNumber,senderPhoneNumber}))
}
