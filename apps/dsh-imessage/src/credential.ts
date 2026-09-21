import { z } from 'zod'

const PhotonIdentitySchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().min(1).optional(),
})

const PhotonProjectCredentialSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  secret: z.string().min(1),
})

const PhotonCredentialV1Schema = z.object({
  version: z.literal(1),
  apiOrigin: z.string().url(),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  account: PhotonIdentitySchema,
  project: PhotonProjectCredentialSchema,
})

const PhotonCredentialV2Schema = z.object({
  version: z.literal(2),
  apiOrigin: z.string().url(),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  account: PhotonIdentitySchema,
  projects: z.array(PhotonProjectCredentialSchema).min(1),
})

/** One Photon project secret retained for Spectrum routing. */
export type PhotonProjectCredential = z.infer<typeof PhotonProjectCredentialSchema>

/** Atomic host-only Photon credential payload (normalized to multi-project). */
export interface PhotonCredential {
  version: 2
  apiOrigin: string
  accessToken: string
  accessTokenExpiresAt: number
  account: z.infer<typeof PhotonIdentitySchema>
  /** All Photon projects used by configured iMessage routes. */
  projects: PhotonProjectCredential[]
}

/** Parse and validate a stored opaque credential, upgrading v1 to multi-project. */
export function parsePhotonCredential(value: string): PhotonCredential {
  const raw: unknown = JSON.parse(value)
  const v2 = PhotonCredentialV2Schema.safeParse(raw)
  if (v2.success) {
    return {
      version: 2,
      apiOrigin: v2.data.apiOrigin,
      accessToken: v2.data.accessToken,
      accessTokenExpiresAt: v2.data.accessTokenExpiresAt,
      account: v2.data.account,
      projects: v2.data.projects,
    }
  }
  const v1 = PhotonCredentialV1Schema.parse(raw)
  return {
    version: 2,
    apiOrigin: v1.apiOrigin,
    accessToken: v1.accessToken,
    accessTokenExpiresAt: v1.accessTokenExpiresAt,
    account: v1.account,
    projects: [v1.project],
  }
}

/** Serialize one opaque credential without intermediate logging. */
export function serializePhotonCredential(value: PhotonCredential): string {
  return JSON.stringify(PhotonCredentialV2Schema.parse({
    version: 2,
    apiOrigin: value.apiOrigin,
    accessToken: value.accessToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    account: value.account,
    projects: value.projects,
  }))
}

/** Find one project credential by exact Photon project name. */
export function findProjectCredential(
  credential: PhotonCredential,
  projectName: string,
): PhotonProjectCredential | undefined {
  return credential.projects.find(project => project.name === projectName)
}

/** Upsert one project secret into the credential document. */
export function upsertProjectCredential(
  credential: PhotonCredential,
  project: PhotonProjectCredential,
): PhotonCredential {
  const others = credential.projects.filter(candidate => candidate.id !== project.id && candidate.name !== project.name)
  return {
    ...credential,
    projects: [...others, project],
  }
}
