import type { Song } from '../types'
import {
  layoutNotation,
  tickAt,
  type Alter,
  type Chord,
  type Clef,
  type Head,
  type Notation,
} from '../song/notation'
import { DARK_PALETTE, type Palette, type RenderFrame } from './renderer'

const MUSIC_FONT = "'Noto Music'"
const GLYPH: Record<Alter, string> = { [-1]: '♭', 0: '♮', 1: '♯' }
const G_CLEF = '\u{1D11E}'
const F_CLEF = '\u{1D122}'
/** Key signature positions, treble clef. The bass clef sits two octaves lower. */
const SHARP_POSITIONS = [38, 35, 39, 36, 33, 37, 34] as const
const FLAT_POSITIONS = [34, 37, 33, 36, 32, 35, 31] as const
/** Bottom line of each staff: E4 and G2. */
const BOTTOM_LINE: Record<Clef, number> = { treble: 30, bass: 18 }
/** Quarter notes shown left of the playhead. */
const PAST_BEATS = 1.2
/** Width of a quarter note in staff spaces. */
const BEAT_SPACES = 8

/** Scrolling grand staff drawn from the same frames as the falling notes. */
export class StaffRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private notation: Notation
  private width = 0
  private height = 0
  palette: Palette = DARK_PALETTE

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly song: Song,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.notation = layoutNotation(song)
    void document.fonts?.load(`20px ${MUSIC_FONT}`, G_CLEF + F_CLEF + Object.values(GLYPH).join(''))
  }

  /** Lays the notes out again, after hands were reassigned. */
  relayout(): void {
    this.notation = layoutNotation(this.song)
  }

  resize(width: number, height: number): void {
    const dpr = globalThis.devicePixelRatio || 1
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.width = width
    this.height = height
  }

  /** Staff space: the distance between two lines. */
  private get g(): number {
    return Math.max(5, Math.min(12, this.height / 19))
  }

  private lineY(clef: Clef, pos: number): number {
    const g = this.g
    const bottom = clef === 'treble' ? 7.5 * g : 15.5 * g
    return bottom - ((pos - BOTTOM_LINE[clef]) * g) / 2
  }

  draw(f: RenderFrame): void {
    if (!this.width) return
    const { ctx, width, height, g, palette: p, notation } = this
    const ink = (a: number) => `rgb(${p.ink} / ${a})`

    const headerW = 4.9 * g + Math.abs(notation.fifths) * 1.05 * g
    const pxPerTick = (BEAT_SPACES * g) / notation.ppq
    const playX = headerW + PAST_BEATS * BEAT_SPACES * g
    const now = tickAt(f.measures, f.songTime)
    const x = (tick: number) => playX + (tick - now) * pxPerTick
    const top = this.lineY('treble', 38)
    const bottom = this.lineY('bass', 18)

    ctx.fillStyle = p.bg
    ctx.fillRect(0, 0, width, height)

    if (f.loop) {
      const a = x(tickAt(f.measures, f.loop.start))
      const b = x(tickAt(f.measures, f.loop.end))
      ctx.fillStyle = ink(0.05)
      ctx.fillRect(a, top - 2 * g, b - a, bottom - top + 4 * g)
    }

    this.drawLines(0, width, ink(0.4))

    ctx.font = `${Math.round(Math.max(10, g * 1.1))}px 'Geist Variable', sans-serif`
    ctx.textAlign = 'left'
    for (const m of f.measures) {
      const mx = x(m.startTick)
      if (mx < headerW - 2 || mx > width + 2) continue
      ctx.fillStyle = ink(0.45)
      ctx.fillRect(Math.round(mx), top, 1, bottom - top)
      ctx.fillStyle = p.gridLabel
      ctx.fillText(String(m.index + 1), mx + 3, top - g * 0.9)
    }

    const fromTick = now - (playX - headerW) / pxPerTick - notation.ppq * 4
    const toTick = now + (width - playX) / pxPerTick + notation.ppq
    const chords = notation.chords
    let i = lowerBound(chords, fromTick)
    const visible: Chord[] = []
    for (; i < chords.length && chords[i]!.tick <= toTick; i++) {
      const c = chords[i]!
      if (f.handModes[c.heads[0]!.note.hand] !== 'hidden') visible.push(c)
    }

    const tips = new Map<Chord, number>()
    for (const beam of notation.beams) {
      if (beam.some((c) => visible.includes(c))) this.drawBeam(beam, x, f, tips)
    }
    for (const c of visible) this.drawChord(c, x(c.tick), f, tips.get(c))

    ctx.fillStyle = ink(0.06)
    ctx.fillRect(playX - g, top - 2.5 * g, 2 * g, bottom - top + 5 * g)
    ctx.fillStyle = p.right
    ctx.fillRect(Math.round(playX) - 1, top - 2.5 * g, 2, bottom - top + 5 * g)

    this.drawHeader(headerW)
  }

  private drawLines(from: number, to: number, color: string): void {
    const { ctx, g } = this
    ctx.fillStyle = color
    for (const clef of ['treble', 'bass'] as const) {
      for (let k = 0; k < 5; k++) {
        const y = Math.round(this.lineY(clef, BOTTOM_LINE[clef] + k * 2))
        ctx.fillRect(from, y, to - from, Math.max(1, g / 10))
      }
    }
  }

  private drawHeader(w: number): void {
    const { ctx, g, palette: p, notation } = this
    const ink = (a: number) => `rgb(${p.ink} / ${a})`
    const top = this.lineY('treble', 38)
    const bottom = this.lineY('bass', 18)

    ctx.fillStyle = p.bg
    ctx.fillRect(0, 0, w, this.height)
    // Stepped, since a gradient to 'transparent' would pass through grey.
    const steps = 8
    for (let k = 0; k < steps; k++) {
      ctx.globalAlpha = 1 - (k + 1) / (steps + 1)
      ctx.fillRect(w + (k * 2 * g) / steps, 0, (2 * g) / steps + 0.5, this.height)
    }
    ctx.globalAlpha = 1

    this.drawLines(g * 0.6, w, ink(0.4))
    ctx.fillStyle = ink(0.6)
    ctx.fillRect(g * 0.6, top, Math.max(1.5, g / 6), bottom - top)

    ctx.fillStyle = ink(0.85)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.font = `${4 * g}px ${MUSIC_FONT}`
    ctx.fillText(G_CLEF, g * 1.1, this.lineY('treble', 32))
    // The F clef glyph's top sits on the top line. Fonts differ in where its baseline is.
    const fAscent = ctx.measureText(F_CLEF).actualBoundingBoxAscent || 0
    ctx.fillText(F_CLEF, g * 1.1, this.lineY('bass', 26) + fAscent)

    const sharps = notation.fifths > 0
    const positions = sharps ? SHARP_POSITIONS : FLAT_POSITIONS
    ctx.font = `${2.6 * g}px ${MUSIC_FONT}`
    ctx.textBaseline = 'middle'
    for (let k = 0; k < Math.abs(notation.fifths); k++) {
      const kx = g * 4.7 + k * g * 1.05
      const glyph = GLYPH[sharps ? 1 : -1]
      ctx.fillText(glyph, kx, this.lineY('treble', positions[k]!))
      ctx.fillText(glyph, kx, this.lineY('bass', positions[k]! - 14))
    }
    ctx.textBaseline = 'alphabetic'
  }

  private headColor(h: Head, f: RenderFrame): string {
    const r = f.results.get(h.note.id)
    if (r?.type === 'hit') return h.note.hand === 'L' ? this.palette.left : this.palette.right
    if (r?.type === 'miss') return this.palette.bad
    return `rgb(${this.palette.ink} / 0.92)`
  }

  private headX(c: Chord, h: Head, cx: number): number {
    const w = this.g * 1.3
    if (!h.flipped) return cx
    return c.stemUp ? cx + w : cx - w
  }

  private stemX(c: Chord, cx: number): number {
    const half = this.g * 0.62
    return c.stemUp ? cx + half : cx - half
  }

  private drawChord(c: Chord, cx: number, f: RenderFrame, beamTip?: number): void {
    const { ctx, g } = this
    const ink = `rgb(${this.palette.ink} / 0.92)`
    const faint = f.handModes[c.heads[0]!.note.hand] !== 'play'
    ctx.globalAlpha = faint ? 0.4 : 1

    this.drawLedgers(c, cx)

    const ys = c.heads.map((h) => this.lineY(c.clef, h.pos))
    const hollow = c.beats >= 2
    for (const [k, h] of c.heads.entries()) {
      const hx = this.headX(c, h, cx)
      const y = ys[k]!
      ctx.save()
      ctx.translate(hx, y)
      ctx.rotate(-0.35)
      ctx.beginPath()
      ctx.ellipse(0, 0, g * 0.62, g * 0.44, 0, 0, Math.PI * 2)
      if (hollow) {
        ctx.strokeStyle = this.headColor(h, f)
        ctx.lineWidth = Math.max(1.2, g * 0.18)
        ctx.stroke()
      } else {
        ctx.fillStyle = this.headColor(h, f)
        ctx.fill()
      }
      ctx.restore()

      if (c.beats === 3 || c.beats === 1.5 || c.beats === 0.75) {
        const onLine = h.pos % 2 === 0
        ctx.fillStyle = ink
        ctx.beginPath()
        ctx.arc(hx + g * 1.15, y - (onLine ? g / 2 : 0), g * 0.16, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    this.drawAccidentals(c, cx, ys, f)

    if (c.beats < 4) {
      const sx = this.stemX(c, cx)
      const far = c.stemUp ? Math.min(...ys) : Math.max(...ys)
      const near = c.stemUp ? Math.max(...ys) : Math.min(...ys)
      const tip = beamTip ?? (c.stemUp ? far - 3.5 * g : far + 3.5 * g)
      ctx.fillStyle = ink
      ctx.fillRect(sx - 0.6, Math.min(near, tip), 1.2, Math.abs(tip - near))
      if (!c.beamed && c.beats < 1) this.drawFlags(c, sx, tip)
    }
    ctx.globalAlpha = 1
  }

  private drawLedgers(c: Chord, cx: number): void {
    const { ctx, g } = this
    const base = BOTTOM_LINE[c.clef]
    const lo = Math.min(...c.heads.map((h) => h.pos))
    const hi = Math.max(...c.heads.map((h) => h.pos))
    const flipped = c.heads.some((h) => h.flipped)
    const left = cx - g * 1.0 - (flipped && !c.stemUp ? g * 1.3 : 0)
    const right = cx + g * 1.0 + (flipped && c.stemUp ? g * 1.3 : 0)
    ctx.fillStyle = `rgb(${this.palette.ink} / 0.6)`
    for (let pos = base - 2; pos >= lo; pos -= 2)
      ctx.fillRect(left, Math.round(this.lineY(c.clef, pos)), right - left, Math.max(1, g / 10))
    for (let pos = base + 10; pos <= hi; pos += 2)
      ctx.fillRect(left, Math.round(this.lineY(c.clef, pos)), right - left, Math.max(1, g / 10))
  }

  private drawAccidentals(c: Chord, cx: number, ys: number[], f: RenderFrame): void {
    const { ctx, g } = this
    const marked = c.heads
      .map((h, k) => ({ h, y: ys[k]! }))
      .filter(({ h }) => h.accidental !== null)
      .toReversed()
    if (!marked.length) return

    const shift = c.heads.some((h) => h.flipped) && !c.stemUp ? g * 1.3 : 0
    const columns: number[][] = []
    ctx.font = `${2.6 * g}px ${MUSIC_FONT}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const { h, y } of marked) {
      let col = columns.findIndex((used) => used.every((pos) => Math.abs(pos - h.pos) >= 6))
      if (col < 0) col = columns.push([]) - 1
      columns[col]!.push(h.pos)
      ctx.fillStyle = this.headColor(h, f)
      ctx.fillText(GLYPH[h.accidental!], cx - g * 0.9 - shift - col * g * 1.1, y)
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  private drawFlags(c: Chord, sx: number, tip: number): void {
    const { ctx, g } = this
    const dir = c.stemUp ? 1 : -1
    ctx.strokeStyle = `rgb(${this.palette.ink} / 0.92)`
    ctx.lineWidth = Math.max(1.2, g * 0.22)
    const flags = c.beats <= 0.25 ? 2 : 1
    for (let k = 0; k < flags; k++) {
      const y = tip + dir * k * g * 0.8
      ctx.beginPath()
      ctx.moveTo(sx, y)
      ctx.bezierCurveTo(
        sx + g * 0.2,
        y + dir * g * 1.0,
        sx + g * 1.3,
        y + dir * g * 1.3,
        sx + g * 1.0,
        y + dir * g * 2.6,
      )
      ctx.stroke()
    }
  }

  /** Draws the beams of a group and records each chord's stem tip on them. */
  private drawBeam(
    beam: Chord[],
    x: (tick: number) => number,
    f: RenderFrame,
    tips: Map<Chord, number>,
  ): void {
    const { ctx, g } = this
    const up = beam[0]!.stemUp
    const dir = up ? -1 : 1
    const stems = beam.map((c) => {
      const ys = c.heads.map((h) => this.lineY(c.clef, h.pos))
      return { c, sx: this.stemX(c, x(c.tick)), far: up ? Math.min(...ys) : Math.max(...ys) }
    })
    const first = stems[0]!
    const last = stems.at(-1)!
    const span = last.sx - first.sx || 1
    let y1 = first.far + dir * 3.5 * g
    let y2 = last.far + dir * 3.5 * g
    const slope = Math.max(-g, Math.min(g, y2 - y1)) / span
    y2 = y1 + slope * span

    // Every stem at least 2.5 spaces long.
    let push = 0
    for (const s of stems) {
      const at = y1 + slope * (s.sx - first.sx)
      const need = s.far + dir * 2.5 * g
      push = Math.max(push, up ? at - need : need - at)
    }
    y1 += dir * push
    y2 += dir * push
    const beamY = (sx: number) => y1 + slope * (sx - first.sx)

    for (const s of stems) tips.set(s.c, beamY(s.sx))

    const faint = f.handModes[first.c.heads[0]!.note.hand] !== 'play'
    ctx.globalAlpha = faint ? 0.4 : 1
    ctx.fillStyle = `rgb(${this.palette.ink} / 0.92)`
    const thick = g * 0.5
    // Beams stack from the stem tips towards the heads.
    const bar = (ax: number, bx: number, depth: number) => {
      ctx.beginPath()
      ctx.moveTo(ax, beamY(ax) - dir * depth)
      ctx.lineTo(bx, beamY(bx) - dir * depth)
      ctx.lineTo(bx, beamY(bx) - dir * (depth + thick))
      ctx.lineTo(ax, beamY(ax) - dir * (depth + thick))
      ctx.closePath()
      ctx.fill()
    }
    const second = thick + g * 0.3
    bar(first.sx, last.sx + 0.6, 0)
    for (const [k, s] of stems.entries()) {
      if (s.c.beats > 0.25) continue
      const next = stems[k + 1]
      const prev = stems[k - 1]
      if (next && next.c.beats <= 0.25) bar(s.sx, next.sx + 0.6, second)
      else if (!prev || prev.c.beats > 0.25) {
        const stub = next ? g * 1.2 : -g * 1.2
        bar(Math.min(s.sx, s.sx + stub), Math.max(s.sx, s.sx + stub), second)
      }
    }
    ctx.globalAlpha = 1
  }
}

function lowerBound(chords: readonly Chord[], tick: number): number {
  let lo = 0
  let hi = chords.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (chords[mid]!.tick < tick) lo = mid + 1
    else hi = mid
  }
  return lo
}
