export const LOWEST = 21
export const HIGHEST = 108
/** Pitch classes of the black keys. */
const BLACK: ReadonlySet<number> = new Set([1, 3, 6, 8, 10])

export const isBlack = (pitch: number): boolean => BLACK.has(pitch % 12)

export interface KeyRect {
  pitch: number
  x: number
  w: number
  black: boolean
}

/** Smallest range of whole octaves (C to B) that covers the pitches, at least two octaves wide. */
export function fitRange(pitches: Iterable<number>): [low: number, high: number] {
  let min = Infinity
  let max = -Infinity
  for (const p of pitches) {
    min = Math.min(min, p)
    max = Math.max(max, p)
  }
  if (min > max) return [LOWEST, HIGHEST]

  let low = Math.floor(min / 12) * 12
  let high = Math.ceil((max + 1) / 12) * 12 - 1
  while (high - low < 23) {
    if (low - 12 >= LOWEST) low -= 12
    else high += 12
  }

  return [Math.max(LOWEST, low), Math.min(HIGHEST, high)]
}

export function layoutKeys(width: number, low = LOWEST, high = HIGHEST): KeyRect[] {
  let whites = 0
  for (let p = low; p <= high; p++) if (!isBlack(p)) whites++
  const whiteW = width / whites
  const blackW = whiteW * 0.62

  const keys: KeyRect[] = []
  let whiteIndex = 0
  for (let p = low; p <= high; p++) {
    if (isBlack(p))
      keys.push({ pitch: p, x: whiteIndex * whiteW - blackW / 2, w: blackW, black: true })
    else keys.push({ pitch: p, x: whiteIndex++ * whiteW, w: whiteW, black: false })
  }
  return keys
}
