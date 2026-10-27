/**
 * Checks automatic hand separation on a folder of MIDI files. For every file it reports how many
 * physically implausible spots the file's own split and the automatic one contain, and, where the
 * file has hands encoded, how often the two agree. File splits are often by staff rather than by
 * hand, so agreement is a sanity check, not a target. Usage: vp run eval:hands [folder ...] [--tune]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'pathe'
import { trackHands } from '../engine/song/hand-split'
import {
  DEFAULT_WEIGHTS,
  playability,
  separateHands,
  type PlayabilityReport,
  type SeparationWeights,
} from '../engine/song/hand-separation'
import { parseSong } from '../engine/song/parse'
import type { Hand, SongNote } from '../engine/types'

const MIDI_FILE = /\.midi?$/i

const args = process.argv.slice(2)
const tune = args.includes('--tune')
const dirs = args.filter((a) => !a.startsWith('--'))
if (!dirs.length) dirs.push(join(import.meta.dirname, '../public/midi'))

interface Case {
  readonly name: string
  readonly notes: readonly SongNote[]
  /** The file's own split, when it has one. */
  readonly truth: readonly Hand[] | null
}

const cases: Case[] = []
for (const dir of dirs) {
  for (const file of readdirSync(dir)) {
    const path = join(dir, file)
    if (!MIDI_FILE.test(file) || !statSync(path).isFile()) continue
    try {
      const song = parseSong(readFileSync(path))
      const map = trackHands(song.tracks)
      cases.push({
        name: file,
        notes: song.notes,
        truth: map ? song.notes.map((n) => map[n.track]!) : null,
      })
    } catch (e) {
      console.warn(`skip ${file}: ${e instanceof Error ? e.message : e}`)
    }
  }
}

const issues = (r: PlayabilityReport) => r.spans + r.crowded + r.leaps
const fmt = (r: PlayabilityReport): string =>
  `${String(issues(r)).padStart(4)} (${r.spans}/${r.crowded}/${r.leaps})`.padEnd(16)
const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(6)

/** Tuning minimises implausible spots first and keeps agreement only as a tiebreaker. */
function objective(w: SeparationWeights): number {
  let bad = 0
  let agree = 0
  for (const { notes, truth } of cases) {
    const hands = separateHands(notes, { weights: w })
    bad += issues(playability(notes, hands)) / notes.length
    if (truth) agree += hands.filter((h, i) => h === truth[i]).length / notes.length
  }

  return agree * 0.1 - bad * 10
}

let weights: SeparationWeights = { ...DEFAULT_WEIGHTS }
if (tune) {
  let best = objective(weights)
  for (let round = 0; round < 3; round++) {
    for (const key of Object.keys(weights) as (keyof SeparationWeights)[]) {
      for (const f of [0.5, 0.75, 1.5, 2]) {
        const trial = { ...weights, [key]: Math.round(weights[key] * f * 1000) / 1000 }
        const m = objective(trial)
        if (m > best + 1e-5) {
          best = m
          weights = trial
          console.log(`  ${key} → ${trial[key]}`)
        }
      }
    }
  }
  console.log('weights', JSON.stringify(weights))
}

console.log(
  `
${'file'.padEnd(46)} notes  file split issues  auto issues      agreement  split@C4 agreement`,
)
for (const { name, notes, truth } of cases) {
  const auto = separateHands(notes, { weights })
  const pitchSplit = notes.map((n): Hand => (n.pitch < 60 ? 'L' : 'R'))
  const agree = (hs: readonly Hand[]) =>
    truth ? pct(hs.filter((h, i) => h === truth[i]).length / notes.length) : '     –'

  console.log(
    [
      name.slice(0, 46).padEnd(46),
      String(notes.length).padStart(5),
      ' ',
      (truth ? fmt(playability(notes, truth)) : '–'.padEnd(16)).padEnd(18),
      fmt(playability(notes, auto)),
      agree(auto).padStart(9),
      agree(pitchSplit).padStart(10),
    ].join(' '),
  )
}
console.log('issues = too wide / more than five notes / impossible jumps')
