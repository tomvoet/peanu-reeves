export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? '–' : `${(value * 100).toFixed(digits)}%`
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded} ms`
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

export function pitchName(pitch: number): string {
  return `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

/** Calm greys for good bars, orange for trouble. Same scale everywhere. */
export function heatColor(accuracy: number | null): string {
  if (accuracy === null) return 'var(--surface-2)'
  if (accuracy >= 0.95) return 'var(--heat-good)'
  if (accuracy >= 0.85) return 'var(--heat-ok)'
  if (accuracy >= 0.75) return 'var(--heat-weak)'
  return 'var(--danger)'
}

/** Readable text colour on top of `heatColor`. */
export function heatInk(accuracy: number | null): string {
  return accuracy !== null && accuracy < 0.75 ? 'var(--inv-text)' : 'var(--heat-ink)'
}

export function formatAgo(at: number | undefined): string {
  if (!at) return 'Never'
  const elapsed = Date.now() - at
  const days = Math.floor(elapsed / 86_400_000)
  if (days <= 0) {
    const hours = Math.floor(elapsed / 3_600_000)
    return hours <= 0 ? 'Just now' : `${hours} h ago`
  }
  if (days === 1) return 'Yesterday'
  if (days < 14) return `${days} days ago`
  return new Date(at).toLocaleDateString()
}
