import type { HandModes, SongNote } from '../types'

export const DEFAULT_HAND_MODES = { L: 'play', R: 'play' } as const satisfies HandModes

export const isExpected = (n: SongNote, modes: HandModes): boolean => modes[n.hand] === 'play'
export const isAutoPlayed = (n: SongNote, modes: HandModes): boolean => modes[n.hand] === 'auto'
export const isVisible = (n: SongNote, modes: HandModes): boolean => modes[n.hand] !== 'hidden'
