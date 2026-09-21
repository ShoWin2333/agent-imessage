/** Stable Cordis and Typert service key. */
export const SERVICE_KEY = 'dshPhotonImessage'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NAME = 'dsh-imessage'

/** Credential reference containing the one atomic Photon credential document. */
export const CREDENTIAL_NAME = 'DSH_IMESSAGE_PHOTON_CREDENTIALS'

/** Default Photon project name when the settings override is unset. */
export const DEFAULT_PHOTON_PROJECT_NAME = 'dsh'

/**
 * @deprecated Use DEFAULT_PHOTON_PROJECT_NAME; kept as an alias for existing imports.
 */
export const PHOTON_PROJECT_NAME = DEFAULT_PHOTON_PROJECT_NAME

/** Compatibility client id shared with Photon CLI. */
export const PHOTON_DEVICE_CLIENT_ID = 'photon-cli'

/** OAuth scopes used by Photon CLI. */
export const PHOTON_DEVICE_SCOPE = 'openid profile email'

/** RFC 8628 device-code grant type. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** Plugin identifier used in DSH message provenance. */
export const PLUGIN_ID = 'dsh-imessage'
