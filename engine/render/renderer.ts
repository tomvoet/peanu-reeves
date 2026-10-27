import type { LoopRange } from '../clock/transport'
import { isVisible } from '../modes/hands'
import type { Hand, HandModes, Measure, SongNote } from '../types'
import { HIGHEST, LOWEST, layoutKeys, type KeyRect } from './keyboard-layout'
import { pedalDown, type AlignedNote, type Interval, type TakeNote } from '../recording/take'

export type NoteResult = { type: 'hit'; time: number; deviationMs: number } | { type: 'miss' }

export type KeyState = 'ok' | 'wrong' | 'free'

export interface RenderFrame {
  songTime: number
  tempo: number
  notes: readonly SongNote[]
  measures: readonly Measure[]
  handModes: HandModes
  results: ReadonlyMap<string, NoteResult>
  wrongs: readonly { pitch: number; time: number }[]
  pressed: ReadonlyMap<number, KeyState>
  loop: LoopRange | null
  waiting: boolean
  /** Set while replaying a recorded take. */
  replay?: ReplayFrame | null
}

export type ReplayMode = 'you' | 'score' | 'both'

/** What the renderer needs to draw a replay. */
export interface ReplayFrame {
  readonly mode: ReplayMode
  readonly notes: readonly AlignedNote[]
  readonly pedal: readonly Interval[]
  /** Another take to compare against instead of the score. */
  readonly reference: readonly TakeNote[] | null
}

/** Free play: what was played rises from the keys and fades with age. */
export interface RisingFrame {
  /** Recording clock, seconds. */
  readonly now: number
  /** Finished notes. */
  readonly notes: readonly TakeNote[]
  /** Keys held right now: pitch → when it went down. */
  readonly held: ReadonlyMap<number, number>
  readonly pressed: ReadonlyMap<number, KeyState>
  readonly pedalDown: boolean
  /** Metronome grid for bar lines, when it is on. */
  readonly bars?: { readonly origin: number; readonly barSec: number } | null
}

/** Callouts drawn next to the most notable notes of a replay. */
const MAX_TAGS = 3

/** Colours come from the app theme (CSS custom properties), so light and dark both work. */
export interface Palette {
  bg: string
  grid: string
  gridLabel: string
  /** "r g b" of the ink colour, for translucent overlays. */
  ink: string
  hitLine: string
  left: string
  leftStripe: string
  right: string
  bad: string
  miss: string
  rim: string
  keyBed: string
  keyWhite: string
  keyBlack: string
  keyBorder: string
  keyLabel: string
  keyLitLabel: string
  /** Glows look wrong on paper, so light themes use soft shadows instead. */
  light: boolean
}

export const DARK_PALETTE = {
  bg: '#000000',
  grid: '#1a1a1a',
  gridLabel: '#8c8c8c',
  ink: '255 255 255',
  hitLine: 'rgb(255 255 255 / 0.25)',
  left: '#4e9be6',
  leftStripe: '#2a63a0',
  right: '#f2b544',
  bad: '#ff5c7a',
  miss: '#a3a3a3',
  rim: '#ffffff',
  keyBed: '#000000',
  keyWhite: '#161616',
  keyBlack: '#050505',
  keyBorder: '#2a2a2a',
  keyLabel: '#8c8c8c',
  keyLitLabel: '#000000',
  light: false,
} as const satisfies Palette

/** Reads the palette from the theme's CSS custom properties on an element. */
export function paletteFrom(el: Element): Palette {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const d = DARK_PALETTE
  return {
    bg: v('--bg', d.bg),
    grid: v('--grid', d.grid),
    gridLabel: v('--faint', d.gridLabel),
    ink: v('--ink', d.ink),
    hitLine: v('--hit-line', d.hitLine),
    left: v('--left', d.left),
    leftStripe: v('--left-stripe', d.leftStripe),
    right: v('--right', d.right),
    bad: v('--danger', d.bad),
    miss: v('--miss', d.miss),
    rim: v('--rim', d.rim),
    keyBed: v('--key-bed', d.keyBed),
    keyWhite: v('--key-white', d.keyWhite),
    keyBlack: v('--key-black', d.keyBlack),
    keyBorder: v('--key-border', d.keyBorder),
    keyLabel: v('--key-label', d.keyLabel),
    keyLitLabel: v('--key-lit-label', d.keyLitLabel),
    light: css.colorScheme.includes('light') && !css.colorScheme.includes('dark'),
  }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** How long a miss ring or wrong-note chip stays visible. */
const FEEDBACK_SEC = 0.7

export type NoteLabels = 'off' | 'c' | 'all'

interface NoteBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface RendererOptions {
  /** Song seconds visible above the keyboard. */
  lookahead: number
  labels?: NoteLabels
  palette?: Palette
  /** Hits within this many ms count as on time (white timing tick). */
  timingWindowMs?: number
}

/** Imperative canvas renderer. Reads a frame snapshot and never touches app state. */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D
  private keys: KeyRect[] = []
  /** Note rectangles from the last frame, for clicking on notes. */
  private hits: NoteBox[] = []
  private low = LOWEST
  private high = HIGHEST
  private width = 0
  private height = 0
  private maxDuration = 0
  private lastNotes: readonly SongNote[] | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    public options: RendererOptions = { lookahead: 2.5 },
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
  }

  private get p(): Palette {
    return this.options.palette ?? DARK_PALETTE
  }

  resize(width: number, height: number): void {
    const dpr = globalThis.devicePixelRatio || 1
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.width = width
    this.height = height
    this.keys = layoutKeys(width, this.low, this.high)
  }

  /** Shows only this pitch range on the keyboard. Both ends should be white keys. */
  setRange(low: number, high: number): void {
    this.low = low
    this.high = high
    this.keys = layoutKeys(this.width, low, high)
  }

  /** Id of the note drawn at a point (CSS pixels), topmost first. */
  noteAt(x: number, y: number): string | null {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const r = this.hits[i]!
      if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2) return r.id
    }
    return null
  }

  private key(pitch: number): KeyRect | undefined {
    return this.keys[pitch - this.low]
  }

  private handColor(hand: Hand): string {
    return hand === 'L' ? this.p.left : this.p.right
  }

  draw(f: RenderFrame): void {
    if (!this.width) return

    this.hits = []
    if (f.notes !== this.lastNotes) {
      this.lastNotes = f.notes
      this.maxDuration = f.notes.reduce((m, n) => Math.max(m, n.endSec - n.startSec), 0)
    }

    const { ctx, width, height, p } = this
    const kbH = Math.min(160, Math.max(80, height * 0.19))
    const hitY = height - kbH
    const pxPerSec = hitY / this.options.lookahead
    const y = (t: number) => hitY - (t - f.songTime) * pxPerSec

    ctx.fillStyle = p.bg
    ctx.fillRect(0, 0, width, height)
    this.drawLanes(hitY)

    if (f.loop) {
      ctx.fillStyle = `rgb(${p.ink} / 0.035)`
      const top = Math.max(0, y(f.loop.end))
      ctx.fillRect(0, top, width, Math.max(0, y(f.loop.start) - top))
    }

    const labelSize = Math.round(Math.max(13, Math.min(18, height / 48)))
    ctx.font = `${labelSize}px 'Geist Variable', sans-serif`
    ctx.textAlign = 'right'
    for (const m of f.measures) {
      const my = y(m.startSec)
      if (my < -20 || my > hitY - 2) continue
      ctx.fillStyle = p.grid
      ctx.fillRect(0, my, width, 1)
      if (my > labelSize + 4) {
        ctx.fillStyle = p.gridLabel
        ctx.fillText(String(m.index + 1), width - 16, my - 8)
      }
    }
    ctx.textAlign = 'start'

    const from = f.songTime - this.maxDuration - 0.5
    const to = f.songTime + this.options.lookahead
    const missed: SongNote[] = []
    const targets: SongNote[] = []

    if (f.replay) {
      this.drawReplay(f, f.replay, y, from, to)
      ctx.fillStyle = p.hitLine
      ctx.fillRect(0, hitY - 1, width, 1)
      this.drawKeyboard(hitY, kbH, f)
      this.drawPedal(f.replay.pedal, f.songTime, hitY)
      return
    }

    for (let i = lowerBound(f.notes, from); i < f.notes.length; i++) {
      const n = f.notes[i]!
      if (n.startSec > to) break
      if (n.endSec < f.songTime - 0.5 || !isVisible(n, f.handModes)) continue
      const result = f.results.get(n.id)
      if (result?.type === 'miss' && f.songTime - n.startSec < FEEDBACK_SEC + 0.3) missed.push(n)
      if (
        f.waiting &&
        !result &&
        f.handModes[n.hand] === 'play' &&
        Math.abs(n.startSec - f.songTime) < 0.06
      )
        targets.push(n)
      this.drawNote(n, y(n.endSec), y(n.startSec), pxPerSec, f)
    }

    ctx.fillStyle = f.waiting ? p.rim : p.hitLine
    ctx.fillRect(0, hitY - 1, width, f.waiting ? 2 : 1)

    this.drawKeyboard(hitY, kbH, f)
    this.drawMisses(missed, hitY)
    this.drawWrongs(f, hitY, kbH)
    this.drawTargets(targets, hitY)
  }

  private drawLanes(hitY: number): void {
    const { ctx, p } = this
    ctx.fillStyle = `rgb(${p.ink} / 0.03)`
    for (const k of this.keys) {
      if (!k.black && k.pitch % 12 === 0) ctx.fillRect(k.x, 0, 1, hitY)
    }
  }

  private drawNote(
    n: SongNote,
    top: number,
    bottom: number,
    pxPerSec: number,
    f: RenderFrame,
  ): void {
    const key = this.key(n.pitch)
    if (!key) return

    const { ctx, p } = this
    const mode = f.handModes[n.hand]
    const color = this.handColor(n.hand)
    const inset = key.black ? 1.5 : Math.min(5, key.w * 0.12)
    const x = key.x + inset
    const w = key.w - inset * 2
    const h = Math.max(4, bottom - top - 2)
    const ny = bottom - h
    this.hits.push({ id: n.id, x, y: ny, w, h })

    const result = f.results.get(n.id)
    // Left: square with a darker centre stripe. Right: rounded. Shape tells hands apart too.
    const radius = n.hand === 'L' ? 2 : Math.min(10, w / 2, h / 2)
    const sounding = n.startSec <= f.songTime && n.endSec > f.songTime

    if (mode === 'ghost') {
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      shape(ctx, x + 0.75, ny + 0.75, w - 1.5, h - 1.5, radius)
      ctx.stroke()
      return
    }

    ctx.globalAlpha = mode === 'auto' ? 0.5 : result?.type === 'miss' ? 0.28 : 1
    if (result?.type === 'hit' || (mode === 'auto' && sounding)) {
      ctx.shadowColor = p.light ? 'rgb(0 0 0 / 0.18)' : color
      ctx.shadowBlur = p.light ? 8 : 22
      ctx.shadowOffsetY = p.light ? 2 : 0
    }
    ctx.fillStyle = color
    shape(ctx, x, ny, w, h, radius)
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0

    if (n.hand === 'L' && w > 6) {
      ctx.fillStyle = p.leftStripe
      ctx.fillRect(x + w * 0.36, ny, w * 0.28, h)
    }
    ctx.globalAlpha = 1

    if (result?.type === 'hit') {
      ctx.strokeStyle = p.rim
      ctx.lineWidth = 2
      shape(ctx, x + 1, ny + 1, w - 2, h - 2, radius)
      ctx.stroke()

      // Where the key was actually struck, relative to the note's start.
      const window = this.options.timingWindowMs ?? 35
      if (Math.abs(result.deviationMs) > window) {
        const dy = (result.deviationMs / 1000) * f.tempo * pxPerSec
        ctx.fillStyle = p.rim
        ctx.globalAlpha = 0.75
        ctx.fillRect(x - 3, bottom - dy - 1, w + 6, 2)
        ctx.globalAlpha = 1
      }
    } else if (!result && mode !== 'auto') {
      ctx.strokeStyle = `rgb(0 0 0 / ${p.light ? 0.18 : 0.35})`
      ctx.lineWidth = 1
      shape(ctx, x + 0.5, ny + 0.5, w - 1, h - 1, radius)
      ctx.stroke()
    }
  }

  private drawKeyboard(top: number, h: number, f: RenderFrame): void {
    const { ctx, p } = this
    const expected = new Map<number, Hand>()
    const sounding = new Map<number, Hand>()
    for (let i = lowerBound(f.notes, f.songTime - this.maxDuration); i < f.notes.length; i++) {
      const n = f.notes[i]!
      if (n.startSec > f.songTime + 0.02) break
      if (n.endSec <= f.songTime || !isVisible(n, f.handModes)) continue
      if (f.handModes[n.hand] !== 'auto') expected.set(n.pitch, n.hand)
      else if (n.startSec <= f.songTime) sounding.set(n.pitch, n.hand)
    }

    ctx.fillStyle = p.keyBed
    ctx.fillRect(0, top, this.width, h)

    const replayed = new Map<number, Hand>()
    if (f.replay && f.replay.mode !== 'score') {
      for (const n of f.replay.notes) {
        if (n.start <= f.songTime && n.end > f.songTime) replayed.set(n.pitch, n.hand)
      }
    }

    const lit = (k: KeyRect): string | null => {
      const fromReplay = replayed.get(k.pitch)
      if (fromReplay) return this.handColor(fromReplay)
      const state = f.pressed.get(k.pitch)
      const hand = expected.get(k.pitch)
      if (state === 'ok' && hand) return this.handColor(hand)
      if (state === 'wrong') return null
      if (state) return `rgb(${p.ink} / 0.35)`
      const auto = sounding.get(k.pitch)
      return auto ? this.handColor(auto) : null
    }

    const glows: { k: KeyRect; c: string }[] = []
    for (const black of [false, true]) {
      for (const k of this.keys) {
        if (k.black !== black) continue
        const kh = black ? h * 0.62 : h
        const c = lit(k)
        ctx.fillStyle = c ?? (black ? p.keyBlack : p.keyWhite)
        ctx.beginPath()
        ctx.roundRect(k.x + (black ? 0 : 0.5), top, k.w - (black ? 0 : 1), kh, [0, 0, 5, 5])
        ctx.fill()
        if (black || !p.light) {
          ctx.strokeStyle = c ?? p.keyBorder
          ctx.lineWidth = 1
          ctx.stroke()
        }
        if (f.pressed.get(k.pitch) === 'wrong') this.hatch(k, top, kh)
        if (c && f.pressed.get(k.pitch) !== 'free') glows.push({ k, c })
        const hand = expected.get(k.pitch)
        if (hand && !f.pressed.has(k.pitch)) {
          ctx.fillStyle = this.handColor(hand)
          ctx.fillRect(k.x + 3, top + kh - 8, k.w - 6, 4)
        }
      }
    }
    this.drawLabels(top, h, (k) => lit(k) !== null)

    // A bright rim where a sounding key meets the lane.
    for (const { k, c } of glows) {
      ctx.shadowColor = c
      ctx.shadowBlur = p.light ? 10 : 18
      ctx.fillStyle = p.rim
      ctx.fillRect(k.x + 4, top - 4, k.w - 8, 4)
    }
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  }

  private hatch(k: KeyRect, top: number, kh: number): void {
    const { ctx, p } = this
    ctx.save()
    ctx.beginPath()
    ctx.rect(k.x, top, k.w, kh)
    ctx.clip()
    ctx.fillStyle = p.bad
    ctx.globalAlpha = 0.3
    ctx.fillRect(k.x, top, k.w, kh)

    ctx.globalAlpha = 0.85
    ctx.lineWidth = 6
    ctx.strokeStyle = p.bad
    for (let d = -kh; d < k.w + kh; d += 14) {
      ctx.beginPath()
      ctx.moveTo(k.x + d, top)
      ctx.lineTo(k.x + d + kh, top + kh)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** × chips above wrongly pressed keys, fading out shortly after the press. */
  private drawWrongs(f: RenderFrame, hitY: number, kbH: number): void {
    const { ctx, p } = this
    const seen = new Set<number>()
    for (let i = f.wrongs.length - 1; i >= 0; i--) {
      const w = f.wrongs[i]!
      const age = f.songTime - w.time
      const held = f.pressed.get(w.pitch) === 'wrong'
      if (seen.has(w.pitch) || (!held && (age > FEEDBACK_SEC || age < -0.2))) continue
      seen.add(w.pitch)

      const k = this.key(w.pitch)
      if (!k) continue

      const size = Math.max(20, Math.min(32, k.w * 1.4))
      const cx = k.x + k.w / 2
      const cy = hitY + (k.black ? kbH * 0.62 : kbH) * 0.45
      ctx.globalAlpha = held ? 1 : Math.max(0, 1 - age / FEEDBACK_SEC)
      ctx.fillStyle = p.bad
      ctx.beginPath()
      ctx.roundRect(cx - size / 2, cy - size / 2, size, size, 7)
      ctx.fill()
      ctx.strokeStyle = p.bg
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.strokeStyle = p.bg
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      const a = size * 0.22
      ctx.beginPath()
      ctx.moveTo(cx - a, cy - a)
      ctx.lineTo(cx + a, cy + a)
      ctx.moveTo(cx + a, cy - a)
      ctx.lineTo(cx - a, cy + a)
      ctx.stroke()
      ctx.lineCap = 'butt'
    }
    ctx.globalAlpha = 1
  }

  /** Hollow rings just above the keys for notes that went by unplayed. */
  private drawMisses(notes: readonly SongNote[], hitY: number): void {
    const { ctx, p } = this
    ctx.strokeStyle = p.miss
    ctx.lineWidth = 3
    for (const n of notes) {
      const k = this.key(n.pitch)
      if (!k) continue
      const r = Math.max(8, Math.min(16, k.w * 0.6))
      ctx.beginPath()
      ctx.arc(k.x + k.w / 2, hitY - r - 10, r, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  /** Pulsing rings on the keys wait mode is holding for. */
  private drawTargets(notes: readonly SongNote[], hitY: number): void {
    if (!notes.length) return

    const { ctx } = this
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const phase = reduced ? 0.4 : (performance.now() % 1200) / 1200
    for (const n of notes) {
      const k = this.key(n.pitch)
      if (!k) continue
      const base = Math.max(14, Math.min(28, k.w))
      ctx.strokeStyle = this.handColor(n.hand)
      ctx.globalAlpha = reduced ? 0.6 : 0.95 * (1 - phase)
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(k.x + k.w / 2, hitY, base * (1 + phase * 0.8), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  /** Free play view: the lane shows the recent past, rising up from the keyboard. */
  drawRising(f: RisingFrame): void {
    if (!this.width) return
    this.hits = []
    const { ctx, width, height, p } = this
    const kbH = Math.min(160, Math.max(80, height * 0.19))
    const hitY = height - kbH
    const pxPerSec = hitY / this.options.lookahead
    const y = (t: number): number => hitY - (f.now - t) * pxPerSec
    const oldest = f.now - this.options.lookahead

    ctx.fillStyle = p.bg
    ctx.fillRect(0, 0, width, height)
    this.drawLanes(hitY)

    if (f.bars) {
      ctx.fillStyle = p.grid
      const first = Math.ceil((oldest - f.bars.origin) / f.bars.barSec)
      for (let k = first; ; k++) {
        const t = f.bars.origin + k * f.bars.barSec
        if (t > f.now) break
        ctx.fillRect(0, y(t), width, 1)
      }
    }

    const draw = (pitch: number, start: number, end: number): void => {
      const key = this.key(pitch)
      if (!key || end < oldest) return
      const inset = key.black ? 1.5 : Math.min(5, key.w * 0.12)
      const top = Math.max(-4, y(start))
      const bottom = y(end)
      ctx.globalAlpha = Math.max(0.15, 1 - ((f.now - end) / this.options.lookahead) * 0.8)
      ctx.fillStyle = p.rim
      shape(ctx, key.x + inset, top, key.w - inset * 2, Math.max(3, bottom - top), 4)
      ctx.fill()
    }
    for (const n of f.notes) draw(n.pitch, n.start, n.soundEnd)
    for (const [pitch, start] of f.held) draw(pitch, start, f.now)
    ctx.globalAlpha = 1

    ctx.fillStyle = p.hitLine
    ctx.fillRect(0, hitY - 1, width, 1)
    this.drawKeyboard(hitY, kbH, {
      songTime: f.now,
      tempo: 1,
      notes: [],
      measures: [],
      handModes: { L: 'play', R: 'play' },
      results: new Map(),
      wrongs: [],
      pressed: f.pressed,
      loop: null,
      waiting: false,
    })
    if (f.pedalDown) {
      ctx.fillStyle = p.rim
      ctx.globalAlpha = 0.55
      ctx.fillRect(0, hitY, width, 6)
      ctx.globalAlpha = 1
    }
  }

  private drawReplay(
    f: RenderFrame,
    replay: ReplayFrame,
    y: (t: number) => number,
    from: number,
    to: number,
  ): void {
    const visible = (start: number, end: number): boolean => end >= from && start <= to

    if (replay.mode === 'score') {
      if (replay.reference) {
        for (const n of replay.reference) {
          if (visible(n.start, n.end)) this.drawPlayed(n, n.pitch < 60 ? 'L' : 'R', y, 1)
        }
      } else {
        for (const n of f.notes) {
          if (!visible(n.startSec, n.endSec) || !isVisible(n, f.handModes)) continue
          this.drawOutline(n.pitch, n.hand, y(n.endSec), y(n.startSec), true)
        }
      }
      return
    }

    if (replay.mode === 'both') {
      if (replay.reference) {
        for (const n of replay.reference) {
          if (visible(n.start, n.end))
            this.drawOutline(n.pitch, n.pitch < 60 ? 'L' : 'R', y(n.end), y(n.start), false)
        }
      } else {
        for (const n of f.notes) {
          if (!visible(n.startSec, n.endSec) || !isVisible(n, f.handModes)) continue
          this.drawOutline(n.pitch, n.hand, y(n.endSec), y(n.startSec), false)
        }
      }
    }

    const tags: { n: AlignedNote; text: string; weight: number }[] = []
    const window = this.options.timingWindowMs ?? 35
    for (const n of replay.notes) {
      if (!visible(n.start, n.end)) continue
      this.drawPlayed(n, n.hand, y, replay.mode === 'both' ? 0.62 : 1)

      if (replay.mode !== 'both' || !n.ref || n.start < f.songTime) continue
      const dev = n.deviationMs ?? 0
      const playedLen = n.end - n.start
      const scoreLen = n.ref.endSec - n.ref.startSec
      if (Math.abs(dev) > Math.max(60, window * 1.5)) {
        const sign = dev > 0 ? '+' : '−'
        tags.push({
          n,
          text: `${sign}${Math.abs(Math.round(dev))} ms ${dev > 0 ? 'late' : 'early'}`,
          weight: Math.abs(dev),
        })
      } else if (playedLen < scoreLen * 0.6 && scoreLen > 0.25) {
        tags.push({ n, text: 'let go early', weight: 80 })
      } else if (playedLen > scoreLen * 1.5 && playedLen - scoreLen > 0.25) {
        tags.push({ n, text: 'held too long', weight: 70 })
      }
    }

    for (const tag of tags.toSorted((a, b) => b.weight - a.weight).slice(0, MAX_TAGS)) {
      this.drawTag(tag.n, tag.text, y)
    }
  }

  /** A played note, coloured by hand. Louder notes are brighter. */
  private drawPlayed(n: TakeNote, hand: Hand, y: (t: number) => number, widthScale: number): void {
    const key = this.key(n.pitch)
    if (!key) return
    const { ctx } = this
    const w = Math.max(3, (key.w - 4) * widthScale)
    const x = key.x + (key.w - w) / 2
    const top = y(n.end)
    const bottom = y(n.start)
    const h = Math.max(4, bottom - top - 2)

    ctx.globalAlpha = 0.45 + 0.55 * Math.min(1, n.velocity / 110)
    ctx.fillStyle = this.handColor(hand)
    shape(ctx, x, bottom - h, w, h, hand === 'L' ? 2 : Math.min(8, w / 2, h / 2))
    ctx.fill()
    ctx.globalAlpha = 1
  }

  /** The note that should have been played, as an outline in its hand's shape. */
  private drawOutline(
    pitch: number,
    hand: Hand,
    top: number,
    bottom: number,
    filled: boolean,
  ): void {
    const key = this.key(pitch)
    if (!key) return
    const { ctx } = this
    const inset = key.black ? 1.5 : Math.min(5, key.w * 0.12)
    const x = key.x + inset
    const w = key.w - inset * 2
    const h = Math.max(4, bottom - top - 2)
    const radius = hand === 'L' ? 2 : Math.min(10, w / 2, h / 2)

    ctx.strokeStyle = this.handColor(hand)
    ctx.lineWidth = 2
    if (filled) {
      ctx.globalAlpha = 0.5
      ctx.fillStyle = this.handColor(hand)
      shape(ctx, x, bottom - h, w, h, radius)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    shape(ctx, x + 1, bottom - h + 1, w - 2, h - 2, radius)
    ctx.stroke()
  }

  private drawTag(n: AlignedNote, text: string, y: (t: number) => number): void {
    const key = this.key(n.pitch)
    if (!key) return
    const { ctx, p } = this
    ctx.font = "15px 'Geist Variable', sans-serif"
    const tw = ctx.measureText(text).width + 16
    const flip = key.x + key.w + tw + 8 > this.width
    const x = flip ? key.x - tw - 6 : key.x + key.w + 6
    const ty = y(n.start) - 26

    ctx.fillStyle = p.bg
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.roundRect(x, ty, tw, 22, 6)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = p.gridLabel
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = p.rim
    ctx.fillText(text, x + 8, ty + 16)
  }

  /** A band along the top of the keyboard while the sustain pedal is down. */
  private drawPedal(pedal: readonly Interval[], t: number, hitY: number): void {
    if (!pedalDown(pedal, t)) return
    const { ctx, p } = this
    ctx.fillStyle = p.rim
    ctx.globalAlpha = 0.55
    ctx.fillRect(0, hitY, this.width, 6)
    ctx.globalAlpha = 1
  }

  private drawLabels(top: number, h: number, isLit: (k: KeyRect) => boolean): void {
    const mode = this.options.labels ?? 'off'
    if (mode === 'off') return

    const { ctx, p } = this
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    for (const k of this.keys) {
      if (k.black || (mode === 'c' && k.pitch % 12 !== 0)) continue
      const size = Math.round(Math.max(10, Math.min(18, k.w * 0.5)))
      ctx.font = `${size}px 'Geist Variable', sans-serif`
      ctx.fillStyle = isLit(k) ? p.keyLitLabel : p.keyLabel
      const name = NAMES[k.pitch % 12]! + (k.pitch % 12 === 0 ? Math.floor(k.pitch / 12) - 1 : '')
      ctx.fillText(name, k.x + k.w / 2, top + h - 12)
    }
    ctx.textAlign = 'start'
  }
}

/** Index of the first note starting at or after `t`. Notes are sorted by start. */
function lowerBound(notes: readonly SongNote[], t: number): number {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid]!.startSec < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function shape(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(1, w), Math.max(1, h), Math.max(0, Math.min(r, w / 2, h / 2)))
}
