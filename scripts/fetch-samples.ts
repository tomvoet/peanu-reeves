/**
 * Downloads the piano sample sets into public/samples so visitors never load audio from a third
 * party. Each tone gets a preset.json with URL-safe sample paths. Existing files are skipped.
 * Usage: vp run samples
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { ElectricPiano, pianoToPreset, type SmplrPreset } from 'smplr'
import { TONES, type ToneId } from '../engine/audio/tones'

const OUT = join(import.meta.dirname, '../public/samples')
const FORMATS = ['ogg', 'm4a']
const CONCURRENCY = 8

// smplr resolves e-piano presets from an SFZ file inside the instrument, so the preset is captured
// where the instrument hands it to loadInstrument. Nothing touches the fake audio context before that.
const fakeContext = (): any =>
  new Proxy(function () {}, {
    get: (_, key) => (key === 'then' ? undefined : fakeContext()),
    apply: () => fakeContext(),
    construct: () => fakeContext(),
  })

function capturePreset(instrument: string): Promise<SmplrPreset> {
  return new Promise((resolve) => {
    const inst = ElectricPiano(fakeContext(), { instrument })
    const proto = Object.getPrototypeOf(inst)
    const original = proto.loadInstrument
    proto.loadInstrument = function (json: SmplrPreset) {
      proto.loadInstrument = original
      resolve(json)
      return new Promise(() => {})
    }
  })
}

function upstreamPreset(id: ToneId): Promise<SmplrPreset> {
  if (id === 'grand') {
    return Promise.resolve(
      pianoToPreset({
        baseUrl: 'https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples',
        decayTime: 0.4,
        detune: 0,
        formats: FORMATS,
      }),
    )
  }
  return capturePreset(TONES[id].upstream!)
}

const slug = (name: string) => name.replaceAll('#', 's').replace(/[^\w.-]+/g, '-')
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

async function download(url: string, file: string): Promise<boolean> {
  if (existsSync(file)) return true
  const res = await fetch(url)
  if (!res.ok) return false
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return true
}

async function pool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) await fn(items[next++]!)
    }),
  )
}

for (const id of Object.keys(TONES) as ToneId[]) {
  const preset = await upstreamPreset(id)
  const dir = join(OUT, id)
  mkdirSync(dir, { recursive: true })

  const base = preset.samples.baseUrl.replace(/\/$/, '')
  const names = [...new Set(preset.groups.flatMap((g) => g.regions.map((r) => r.sample)))]
  const map: Record<string, string> = {}
  const missing: string[] = []

  await pool(names, async (name) => {
    const path = preset.samples.map?.[name] ?? name
    map[name] = slug(name)
    for (const format of FORMATS) {
      const url = `${base}/${encodePath(path)}.${format}`
      if (!(await download(url, join(dir, `${map[name]}.${format}`))))
        missing.push(`${name}.${format}`)
    }
  })

  // smplr picks one format per instrument, so a format with gaps upstream is dropped entirely.
  const formats = FORMATS.filter((f) => !missing.some((m) => m.endsWith(`.${f}`)))
  if (!formats.length) throw new Error(`${id}: no complete format, missing ${missing.join(', ')}`)
  for (const format of FORMATS.filter((f) => !formats.includes(f))) {
    for (const file of Object.values(map)) rmSync(join(dir, `${file}.${format}`), { force: true })
  }

  const local: SmplrPreset = { ...preset, samples: { baseUrl: '', formats, map } }
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(local))
  console.log(`${id}: ${names.length} samples as ${formats.join(', ')}`)
}

// ElectricPiano keeps a pending fetch in the fake instrument, so exit explicitly.
process.exit(0)
