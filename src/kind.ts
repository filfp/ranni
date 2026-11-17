import { RanniError } from './errors'

/** The kind a new project gets when nothing names one. */
export const DEFAULT_KIND = 'ticket'
/** The kind Ranni 0.2 hard-coded; a project that already declares it keeps it. */
export const LEGACY_KIND = 'work'
/** The metadata key of the shared ranni.md document that names the work kind. */
export const KIND_KEY = 'ranni-kind'
export const RANNI_DOC = 'ranni.md'
export const RANNI_DOC_ID = 'SHARED-ranni'

const KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const RESERVED_KINDS = new Set(['spec', 'shared'])

/** Throws unless Relic would accept `kind` as a record kind key. */
export function validateKind(kind: string): string {
  if (RESERVED_KINDS.has(kind)) throw new RanniError(`"${kind}" is reserved by Relic; pick another kind name.`)
  if (!KIND_PATTERN.test(kind)) {
    throw new RanniError(
      `"${kind}" is not a valid record kind: start with a lowercase letter and use only lowercase letters, digits and single hyphens.`,
    )
  }
  return kind
}

/** The trailer key and identity prefix for a kind: ticket gives Ticket: and TICKET-042. */
export const trailerKey = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1)
export const idPrefix = (kind: string) => kind.toUpperCase()
