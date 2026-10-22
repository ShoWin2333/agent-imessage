/** Portable absolute-path syntax; filesystem existence and canonical scope are checked by the host. */
export const absoluteWorkspacePattern = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/
