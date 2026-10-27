import tonejs from '@tonejs/midi'
import type { HandSplit, Song, SongNote, TrackInfo } from '../types'
import { assignHands, resolveHandSplit } from './hand-split'
import { buildMeasures, measureAtTick } from './measures'
import { sanitizeMidi } from './sanitize'
import { TempoMap } from './tempo-map'

// Default import works both in Vite and in plain Node (the package is CommonJS).
const { Midi } = tonejs

/** Key names @tonejs/midi reports, from seven flats to seven sharps. */
const KEYS_BY_FIFTHS = [
  'Cb',
  'Gb',
  'Db',
  'Ab',
  'Eb',
  'Bb',
  'F',
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F#',
  'C#',
]

export interface MidiSummary {
  title: string
  durationSec: number
  trackCount: number
}

export function summarizeMidi(data: ArrayBuffer | Uint8Array): MidiSummary {
  const midi = new Midi(sanitizeMidi(data))
  return {
    title: midi.header.name,
    durationSec: midi.duration,
    trackCount: midi.tracks.filter((t) => t.notes.length > 0).length,
  }
}

export interface ParseOptions {
  title?: string
  handSplit?: HandSplit
}

export function parseSong(data: ArrayBuffer | Uint8Array, opts: ParseOptions = {}): Song {
  const midi = new Midi(sanitizeMidi(data))
  const { header } = midi
  const tempoMap = new TempoMap(
    header.ppq,
    header.tempos.map((t) => ({ ticks: t.ticks, bpm: t.bpm })),
  )

  const tracks: TrackInfo[] = midi.tracks.map((t, index) => ({
    index,
    name: t.name || `Track ${index + 1}`,
    noteCount: t.instrument.percussion ? 0 : t.notes.length,
    meanPitch: t.notes.length ? t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length : 0,
  }))

  const handSplit = resolveHandSplit(tracks, opts.handSplit)
  const raw = midi.tracks.flatMap((t, track) =>
    t.instrument.percussion ? [] : t.notes.map((n, i) => ({ n, track, i })),
  )
  const endTick = Math.max(1, ...raw.map(({ n }) => n.ticks + n.durationTicks))
  const measures = buildMeasures(
    tempoMap,
    header.timeSignatures.map((ts) => ({
      ticks: ts.ticks,
      numerator: ts.timeSignature[0] ?? 4,
      denominator: ts.timeSignature[1] ?? 4,
    })),
    endTick,
  )

  const notes: SongNote[] = raw
    .map(({ n, track, i }): SongNote => {
      const end = n.ticks + Math.max(1, n.durationTicks)
      return {
        id: `${track}:${i}`,
        pitch: n.midi,
        startTick: n.ticks,
        endTick: end,
        startSec: tempoMap.ticksToSeconds(n.ticks),
        endSec: tempoMap.ticksToSeconds(end),
        velocity: Math.max(1, Math.round(n.velocity * 127)),
        hand: 'R',
        measure: measureAtTick(measures, n.ticks),
        track,
      }
    })
    .sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch)

  const hands = assignHands(notes, handSplit)
  notes.forEach((n, i) => (n.hand = hands[i]!))

  return {
    title: opts.title ?? (header.name || 'Untitled'),
    ppq: header.ppq,
    durationSec: tempoMap.ticksToSeconds(endTick),
    notes,
    measures,
    tracks,
    handSplit,
    keyFifths: keyFifthsOf(header.keySignatures[0]?.key),
  }
}

function keyFifthsOf(key: string | undefined): number | undefined {
  const i = key === undefined ? -1 : KEYS_BY_FIFTHS.indexOf(key)
  return i < 0 ? undefined : i - 7
}
