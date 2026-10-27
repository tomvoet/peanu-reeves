import tonejs from '@tonejs/midi'
import { notesOf, type TakeEvent } from './take'

const { Midi } = tonejs

export interface ExportOptions {
  readonly name: string
  readonly bpm?: number
  readonly beatsPerBar?: number
  /** Divides event times before writing, e.g. a take's tempo factor to get real time. */
  readonly timeScale?: number
}

/** Writes played events as a one-track MIDI file (notes, velocity, sustain pedal). */
export function eventsToMidi(events: readonly TakeEvent[], opts: ExportOptions): Uint8Array {
  const scale = opts.timeScale ?? 1
  const first = events.reduce((m, e) => Math.min(m, e.t), Infinity)
  const origin = Number.isFinite(first) ? first : 0
  const at = (t: number): number => Math.max(0, (t - origin) / scale)

  const midi = new Midi()
  midi.header.name = opts.name
  midi.header.setTempo(opts.bpm ?? 120)
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [opts.beatsPerBar ?? 4, 4] })

  const track = midi.addTrack()
  track.name = opts.name
  for (const n of notesOf(events).notes) {
    track.addNote({
      midi: n.pitch,
      time: at(n.start),
      duration: Math.max(0.01, (n.end - n.start) / scale),
      velocity: n.velocity / 127,
    })
  }
  for (const e of events) {
    if (e.kind === 'pedal') track.addCC({ number: e.cc, value: e.value / 127, time: at(e.t) })
  }

  return midi.toArray()
}
