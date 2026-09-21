/** The parent only needs the mount service; the nested face is created by apply(). */
export const inject = ['remote']

/** Services consumed after the generated Remote contribution has mounted. */
export const settingsInject = ['slots', 'remote.dshPhotonImessage']
