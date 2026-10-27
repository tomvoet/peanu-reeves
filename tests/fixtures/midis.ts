import { createRequire } from 'node:module'

// @tonejs/midi is CommonJS without named ESM exports under plain Node.
const { Midi } = createRequire(import.meta.url)('@tonejs/midi') as typeof import('@tonejs/midi')

const PPQ = 480
const Q = PPQ
const E = PPQ / 2
const H = PPQ * 2
const DH = PPQ * 3

type Step = [pitch: number | number[], duration: number]

function addLine(
  track: ReturnType<InstanceType<typeof Midi>['addTrack']>,
  steps: Step[],
  start = 0,
  velocity = 0.7,
) {
  let ticks = start
  for (const [pitch, duration] of steps) {
    for (const midi of [pitch].flat()) {
      track.addNote({ midi, ticks, durationTicks: Math.round(duration * 0.95), velocity })
    }
    ticks += duration
  }
  return ticks
}

function create(name: string, bpm: number, sig: [number, number] = [4, 4]) {
  const midi = new Midi()
  midi.header.name = name
  midi.header.tempos.push({ ticks: 0, bpm })
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: sig })
  midi.header.update()
  return midi
}

/** Single track holding both hands: exercises the pitch split. */
export function twinkle(): Uint8Array {
  const midi = create('Twinkle, Twinkle', 120)
  const track = midi.addTrack()
  track.name = 'Piano'
  const C4 = 60,
    D4 = 62,
    E4 = 64,
    F4 = 65,
    G4 = 67,
    A4 = 69
  addLine(track, [
    [C4, Q],
    [C4, Q],
    [G4, Q],
    [G4, Q],
    [A4, Q],
    [A4, Q],
    [G4, H],
    [F4, Q],
    [F4, Q],
    [E4, Q],
    [E4, Q],
    [D4, Q],
    [D4, Q],
    [C4, H],
  ])
  addLine(
    track,
    [
      [[48, 55], H * 2],
      [[53, 57], H],
      [[48, 55], H],
      [[53, 57], H],
      [[48, 55], H],
      [[50, 55], H],
      [[48, 52], H],
    ],
    0,
    0.55,
  )
  return midi.toArray()
}

/** Two tracks, one per hand (Petzold, Minuet in G, first eight bars). */
export function minuet(): Uint8Array {
  const midi = create('Minuet in G', 112, [3, 4])
  const rh = midi.addTrack()
  rh.name = 'Right hand'
  addLine(rh, [
    [74, Q],
    [67, E],
    [69, E],
    [71, E],
    [72, E],
    [74, Q],
    [67, Q],
    [67, Q],
    [76, Q],
    [72, E],
    [74, E],
    [76, E],
    [78, E],
    [79, Q],
    [67, Q],
    [67, Q],
    [72, Q],
    [74, E],
    [72, E],
    [71, E],
    [69, E],
    [71, Q],
    [72, E],
    [71, E],
    [69, E],
    [67, E],
    [66, Q],
    [67, E],
    [69, E],
    [71, E],
    [67, E],
    [69, DH],
  ])
  const lh = midi.addTrack()
  lh.name = 'Left hand'
  addLine(
    lh,
    [
      [[55, 59], H],
      [57, Q],
      [59, DH],
      [60, DH],
      [59, DH],
      [57, DH],
      [55, DH],
      [62, H],
      [59, Q],
      [62, Q],
      [50, Q],
      [54, Q],
    ],
    0,
    0.55,
  )
  return midi.toArray()
}

/** Tempo and meter changes: 100 bpm → 140 bpm at bar 3 → 3/4 at 80 bpm from bar 5. */
export function tempoChanges(): Uint8Array {
  const midi = create('Tempo Changes', 100)
  midi.header.tempos.push({ ticks: 8 * Q, bpm: 140 }, { ticks: 16 * Q, bpm: 80 })
  midi.header.timeSignatures.push({ ticks: 16 * Q, timeSignature: [3, 4] })
  midi.header.update()
  const track = midi.addTrack()
  track.name = 'Scale'
  const up = [60, 62, 64, 65, 67, 69, 71, 72]
  const end = addLine(
    track,
    [...up, ...up.toReversed()].map((p): Step => [p, Q]),
  )
  addLine(
    track,
    [
      [[60, 64, 67], DH],
      [[59, 62, 67], DH],
      [[60, 64, 67, 72], DH],
    ],
    end,
  )
  return midi.toArray()
}

export const TEST_MIDIS = {
  'twinkle.mid': twinkle,
  'minuet.mid': minuet,
  'tempo-changes.mid': tempoChanges,
}
