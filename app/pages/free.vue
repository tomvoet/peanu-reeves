<script setup lang="ts">
import type { Recording } from '#db/schema'
import { scheduleClick } from '#engine/audio/click'
import { isEditable, KeyboardInput } from '#engine/midi-input/keyboard'
import { eventsToMidi } from '#engine/recording/export'
import { guessKey } from '#engine/recording/key'
import { TakePlayer } from '#engine/recording/player'
import {
  notesOf,
  shiftEvents,
  sliceEvents,
  trimBuffer,
  type TakeEvent,
  type TakeNote,
} from '#engine/recording/take'
import { HIGHEST, LOWEST } from '#engine/render/keyboard-layout'
import { paletteFrom, Renderer, type KeyState } from '#engine/render/renderer'
import { thumbnailOfNotes } from '#engine/song/thumbnail'
import type { FreePlayDraft } from '~/composables/useFreePlayDraft'

type Phase = 'live' | 'stopped' | 'saved'

/** Everything played is kept this long even without pressing record. */
const BUFFER_SEC = 600
/** Silence kept around the first and last note when trimming. */
const LEAD_SEC = 0.3
const TAIL_SEC = 0.8
const BEATS_PER_BAR = [3, 4] as const
const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const route = useRoute()
const runtime = useRuntime()
const repos = useRepos()
const library = useLibrary()
const settings = useSettings()
const midi = useMidiStatus()
const theme = useTheme()
const draft = useFreePlayDraft()

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const stage = useTemplateRef<HTMLElement>('stage')
const renderer = shallowRef<Renderer>()

const phase = ref<Phase>('live')
const recordingFrom = ref<number | null>(null)
const now = ref(0)
const noteCount = ref(0)
const usedPedal = ref(false)
const metronome = ref(false)
const bpm = ref(72)
const beatsPerBar = ref<(typeof BEATS_PER_BAR)[number]>(4)
const name = ref('')
const confirmDiscard = refAutoReset(false, 4000)
const saved = shallowRef<Recording | null>(null)
const notice = refAutoReset<string | null>(null, 3500)

// Live input, outside Vue reactivity: it changes on every key press and is drawn every frame.
let buffer: TakeEvent[] = []
let finished: TakeNote[] = []
const held = new Map<number, number>()
const pressed = new Map<number, KeyState>()
let pedalDown = false
let metronomeOrigin = 0
let nextBeat = 0

/**
 * Recording runs on the page clock, not the audio clock: the audio clock stands still until
 * Chrome lets audio start (a click is needed), and keys played before that would be lost.
 */
const clockNow = (): number => performance.now() / 1000
const audioNow = (): number => runtime.clock.now()
const elapsed = computed(() =>
  recordingFrom.value === null ? 0 : Math.max(0, now.value - recordingFrom.value),
)
const bufferedSec = computed(() => {
  const first = buffer[0]?.t
  return first === undefined ? 0 : Math.min(BUFFER_SEC, now.value - first)
})

// What the save and playback views show.
const current = computed<FreePlayDraft | null>(() => {
  if (phase.value === 'saved' && saved.value) {
    return {
      events: saved.value.events,
      durationSec: saved.value.durationSec,
      trimFrom: 0,
      trimTo: saved.value.durationSec,
      createdAt: saved.value.createdAt,
      bpm: saved.value.bpm,
      beatsPerBar: saved.value.beatsPerBar,
      metronome: !!saved.value.thumb?.barStarts.length,
    }
  }
  return phase.value === 'stopped' ? draft.value : null
})
const currentNotes = computed(() => (current.value ? notesOf(current.value.events) : null))
const keptLength = computed(() =>
  current.value ? current.value.trimTo - current.value.trimFrom : 0,
)
const keyGuess = computed(() => {
  const c = current.value
  const notes = currentNotes.value?.notes ?? []
  return c ? guessKey(notes.filter((n) => n.start >= c.trimFrom && n.start <= c.trimTo)) : null
})
const keyName = computed(() =>
  keyGuess.value ? `${keyGuess.value.tonic} ${keyGuess.value.mode}` : null,
)
const suggestions = computed(() =>
  keyName.value ? [`Sketch in ${keyName.value}`, `Idea in ${keyName.value}`] : [],
)

// Live view.
function onNoteOn(pitch: number, velocity: number): void {
  const t = clockNow()
  buffer.push({ kind: 'on', t, pitch, velocity })
  held.set(pitch, t)
  pressed.set(pitch, 'free')
}

function onNoteOff(pitch: number): void {
  const t = clockNow()
  buffer.push({ kind: 'off', t, pitch })
  const start = held.get(pitch)
  if (start !== undefined) {
    finished.push({ pitch, start, end: t, soundEnd: t, velocity: 80 })
    if (finished.length > 4000) finished = finished.slice(-2000)
  }
  held.delete(pitch)
  pressed.delete(pitch)
}

function onPedal(cc: number, value: number): void {
  const t = clockNow()
  buffer.push({ kind: 'pedal', t, cc, value })
  if (cc === 64) pedalDown = value >= 64
}

const offs = [
  runtime.input.onNoteOn((pitch, velocity) => onNoteOn(pitch, velocity)),
  runtime.input.onNoteOff((pitch) => onNoteOff(pitch)),
  runtime.input.onPedal((cc, value) => onPedal(cc, value)),
]

useRafFn(() => {
  if (phase.value !== 'live') return
  const t = clockNow()
  renderer.value?.drawRising({
    now: t,
    notes: finished,
    held,
    pressed,
    pedalDown,
    bars: metronome.value ? { origin: metronomeOrigin, barSec: barSec() } : null,
  })
  if (metronome.value) scheduleBeats(t)
})

useIntervalFn(() => {
  now.value = clockNow()
  if (recordingFrom.value === null) buffer = trimBuffer(buffer, now.value, BUFFER_SEC)
  const from = recordingFrom.value ?? -Infinity
  const recent = buffer.filter((e) => e.t >= from)
  noteCount.value = recent.filter((e) => e.kind === 'on').length
  usedPedal.value = recent.some((e) => e.kind === 'pedal')
  if (player.value?.playing) playhead.value = player.value.position
}, 100)

watch(canvas, (el) => {
  if (!el) return
  renderer.value = new Renderer(el, { lookahead: 4, labels: settings.noteLabels })
  renderer.value.setRange(LOWEST, HIGHEST)
  renderer.value.resize(stage.value?.clientWidth ?? 0, stage.value?.clientHeight ?? 0)
})

watch(
  [renderer, theme],
  ([r]) => {
    if (r) r.options.palette = paletteFrom(document.documentElement)
  },
  { flush: 'post' },
)

useResizeObserver(stage, ([entry]) => {
  if (entry) renderer.value?.resize(entry.contentRect.width, entry.contentRect.height)
})

// Metronome.
const barSec = (): number => (60 / bpm.value) * beatsPerBar.value

function toggleMetronome(): void {
  metronome.value = !metronome.value
  if (!metronome.value) return
  void runtime.ctx.resume()
  metronomeOrigin = clockNow() + 0.1
  nextBeat = 0
}

function scheduleBeats(t: number): void {
  const beat = 60 / bpm.value
  while (metronomeOrigin + nextBeat * beat < t + 0.2) {
    const at = metronomeOrigin + nextBeat * beat
    if (at >= t - 0.05) {
      scheduleClick(
        runtime.ctx,
        runtime.ctx.currentTime + (at - t),
        nextBeat % beatsPerBar.value === 0,
      )
    }
    nextBeat++
  }
}

watch([bpm, beatsPerBar], () => {
  if (!metronome.value) return
  metronomeOrigin = clockNow() + 0.1
  nextBeat = 0
})

// Recording.
function toggleRecording(): void {
  if (phase.value !== 'live') return newRecording()
  if (recordingFrom.value === null) {
    void runtime.ctx.resume()
    recordingFrom.value = clockNow()
    return
  }
  stopAt(recordingFrom.value, clockNow())
}

/** Keeps what was played without pressing record: up to the last ten minutes. */
function saveBuffer(): void {
  const first = buffer.find((e) => e.kind === 'on')
  if (!first) return
  stopAt(Math.max(first.t - LEAD_SEC, clockNow() - BUFFER_SEC), clockNow())
}

function stopAt(from: number, to: number): void {
  recordingFrom.value = null
  const events = shiftEvents(sliceEvents(buffer, from, to), -from)
  const { notes } = notesOf(events)
  const duration = to - from
  const firstStart = notes[0]?.start ?? 0
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.soundEnd), 0)

  draft.value = {
    events,
    durationSec: duration,
    trimFrom: Math.max(0, firstStart - LEAD_SEC),
    trimTo: Math.min(duration, lastEnd + TAIL_SEC),
    createdAt: Date.now(),
    bpm: bpm.value,
    beatsPerBar: beatsPerBar.value,
    metronome: metronome.value,
  }
  name.value = `Free play · ${dateFmt.format(draft.value.createdAt)}`
  phase.value = 'stopped'
}

function newRecording(): void {
  stopPlayback()
  saved.value = null
  phase.value = 'live'
  if (route.query.recording) void navigateTo('/free', { replace: true })
}

function setTrim(edge: 'trimFrom' | 'trimTo', sec: number): void {
  const d = draft.value
  if (!d || phase.value !== 'stopped') return
  const clamped =
    edge === 'trimFrom'
      ? Math.min(Math.max(0, sec), d.trimTo - 0.5)
      : Math.max(Math.min(d.durationSec, sec), d.trimFrom + 0.5)
  draft.value = { ...d, [edge]: clamped }
}

function trimmedEvents(d: FreePlayDraft): TakeEvent[] {
  return shiftEvents(sliceEvents(d.events, d.trimFrom, d.trimTo), -d.trimFrom)
}

async function save(): Promise<void> {
  const d = draft.value
  if (!d || phase.value !== 'stopped') return

  const events = trimmedEvents(d)
  const durationSec = d.trimTo - d.trimFrom
  const recording: Omit<Recording, 'id'> = {
    title: name.value.trim() || `Free play · ${dateFmt.format(d.createdAt)}`,
    createdAt: d.createdAt,
    durationSec,
    bpm: d.bpm,
    beatsPerBar: d.beatsPerBar,
    events,
    thumb: thumbnailOfNotes(
      notesOf(events).notes,
      durationSec,
      d.metronome ? (60 / d.bpm) * d.beatsPerBar : undefined,
    ),
  }
  const id = await repos.recordings.add(recording)
  draft.value = null
  saved.value = { ...recording, id }
  phase.value = 'saved'
  notice.value = 'Saved to Recordings'
  if (id !== undefined) void navigateTo({ query: { recording: id } }, { replace: true })
}

function discard(): void {
  if (!confirmDiscard.value) {
    confirmDiscard.value = true
    return
  }
  draft.value = null
  newRecording()
}

function exportMidi(): void {
  const c = current.value
  if (!c) return
  const title = phase.value === 'saved' ? (saved.value?.title ?? name.value) : name.value
  const events = phase.value === 'saved' ? c.events : trimmedEvents(c)
  const bytes = eventsToMidi(events, { name: title, bpm: c.bpm, beatsPerBar: c.beatsPerBar })
  downloadFile(`${safeFileName(title)}.mid`, 'audio/midi', bytes)
}

/** Turns a recording into a piece in the library, to practise like any other. */
const adding = ref(false)

async function practise(): Promise<void> {
  const r = saved.value
  if (!r || adding.value) return
  adding.value = true
  const bytes = eventsToMidi(r.events, { name: r.title, bpm: r.bpm, beatsPerBar: r.beatsPerBar })
  const file = new File([new Uint8Array(bytes)], `${safeFileName(r.title)}.mid`, {
    type: 'audio/midi',
  })
  try {
    const [hash] = await library.importFiles([file])
    if (hash) await navigateTo(`/practice/${hash}`)
  } finally {
    adding.value = false
  }
}

async function renameSaved(): Promise<void> {
  const r = saved.value
  const title = name.value.trim()
  if (!r?.id || !title || title === r.title) return
  await repos.recordings.rename(r.id, title)
  saved.value = { ...r, title }
}

async function deleteSaved(): Promise<void> {
  const r = saved.value
  if (!r?.id) return
  if (!confirmDiscard.value) {
    confirmDiscard.value = true
    return
  }
  await repos.recordings.remove(r.id)
  await navigateTo('/')
}

// Playback of a draft or a saved recording.
const player = shallowRef<TakePlayer | null>(null)
const playhead = ref(0)
const isPlaying = computed(() => !!player.value?.playing && playhead.value >= 0)

function togglePlayback(): void {
  const c = current.value
  if (!c) return
  if (player.value?.playing) return stopPlayback()

  const notes = notesOf(phase.value === 'saved' ? c.events : trimmedEvents(c)).notes
  player.value = new TakePlayer(runtime.piano, notes, audioNow, () => {
    playhead.value = 0
    player.value = null
  })
  player.value.play(0)
  playhead.value = 0
}

function stopPlayback(): void {
  player.value?.stop()
  player.value = null
  playhead.value = 0
}

// Trim handles on the overview.
const overview = useTemplateRef<HTMLElement>('overview')
let dragging: 'trimFrom' | 'trimTo' | null = null

function trimDown(edge: 'trimFrom' | 'trimTo', e: PointerEvent): void {
  if (phase.value !== 'stopped') return
  dragging = edge
  if (e.currentTarget instanceof HTMLElement) e.currentTarget.setPointerCapture(e.pointerId)
}

function trimMove(e: PointerEvent): void {
  const d = draft.value
  const box = overview.value?.getBoundingClientRect()
  if (!dragging || !d || !box) return
  setTrim(dragging, ((e.clientX - box.left) / box.width) * d.durationSec)
}

const pct = (sec: number): string =>
  `${current.value ? (sec / current.value.durationSec) * 100 : 0}%`

// Keyboard: keys that also play notes on the computer keyboard need Alt while it is on.
function shortcut(e: KeyboardEvent, action: () => void): void {
  if (isEditable(e.target) && e.code !== 'Enter') return
  const playsNote = settings.keyboardInput && KeyboardInput.pitchOffset(e.code) !== null
  if (playsNote !== e.altKey) return
  e.preventDefault()
  action()
}

const byCode = (code: string, action: () => void, when: () => boolean = () => true) =>
  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if (e.code === code && !e.repeat && when()) shortcut(e, action)
  })

byCode('KeyR', toggleRecording)
byCode('KeyM', toggleMetronome, () => phase.value === 'live')
byCode(
  'BracketLeft',
  () => (bpm.value = Math.max(30, bpm.value - 2)),
  () => phase.value === 'live',
)
byCode(
  'BracketRight',
  () => (bpm.value = Math.min(240, bpm.value + 2)),
  () => phase.value === 'live',
)
byCode('Space', togglePlayback, () => phase.value !== 'live')
byCode(
  'Enter',
  () => void save(),
  () => phase.value === 'stopped',
)
byCode('KeyE', exportMidi, () => phase.value !== 'live')

// Opening /free?recording=<id> shows a saved recording.
watch(
  () => route.query.recording,
  async (id) => {
    if (!id) return
    const r = await repos.recordings.get(Number(id))
    if (!r) return
    stopPlayback()
    saved.value = r
    name.value = r.title
    phase.value = 'saved'
  },
  { immediate: true },
)

onMounted(() => {
  if (!route.query.recording && draft.value) {
    phase.value = 'stopped'
    name.value = `Free play · ${dateFmt.format(draft.value.createdAt)}`
  }
})

// The piano key or pedal bound to play/pause starts and stops recording here.
const offRemote = runtime.remote.on('toggle', () =>
  phase.value === 'live' ? toggleRecording() : togglePlayback(),
)

useWakeLock()
  .request('screen')
  .catch(() => {})

onBeforeUnmount(() => {
  offs.forEach((off) => off())
  offRemote()
  stopPlayback()
})
</script>

<template>
  <div class="free" :class="phase">
    <header class="head">
      <div v-if="phase === 'live'" class="hud">
        <template v-if="recordingFrom !== null">
          <div class="big num">
            <i class="rec-dot" aria-hidden="true" /><b>{{ formatDuration(elapsed) }}</b>
            <small>recording</small>
          </div>
          <p class="muted">
            {{ noteCount }} notes<template v-if="usedPedal"> · pedal</template> · not saved yet
          </p>
        </template>
        <template v-else>
          <div class="big num">
            <b>Free play</b>
          </div>
          <p class="muted">
            Play anything. The last {{ formatDuration(bufferedSec) }} are kept, so nothing is lost
            if you forget to record.
          </p>
        </template>
      </div>

      <div v-else class="hud">
        <p class="eyebrow">
          {{ phase === 'saved' ? 'Saved recording' : 'Recording stopped' }} ·
          {{ current ? dateFmt.format(current.createdAt) : '' }}
        </p>
        <div class="big num">
          <b>{{ formatDuration(keptLength) }}</b>
          <small v-if="phase === 'stopped' && current && keptLength < current.durationSec - 0.5"
            >trimmed from {{ formatDuration(current.durationSec) }}</small
          >
        </div>
        <p class="muted">
          {{ currentNotes?.notes.length ?? 0 }} notes<template v-if="currentNotes?.pedal.length">
            · pedal</template
          ><template v-if="current?.metronome">
            · {{ current.bpm }} bpm, {{ current.beatsPerBar }}/4</template
          >
        </p>
      </div>

      <span class="spacer" />

      <div class="side">
        <NuxtLink
          to="/settings"
          class="status-pill"
          :class="{ off: !midi.devices.length }"
          :title="midi.devices.length ? 'MIDI input' : 'Open settings to connect a keyboard'"
          ><i />{{
            midi.devices.length
              ? midi.devices.map((d) => d.name).join(', ')
              : 'No MIDI device · computer keys'
          }}</NuxtLink
        >
      </div>
    </header>

    <div v-show="phase === 'live'" ref="stage" class="stage">
      <canvas ref="canvas" />
      <div class="toast" aria-live="polite">
        <span v-if="notice">{{ notice }}</span>
      </div>
    </div>

    <section v-if="phase !== 'live' && current" class="review">
      <div class="overview-wrap">
        <div
          ref="overview"
          class="overview"
          @pointermove="trimMove"
          @pointerup="dragging = null"
          @pointercancel="dragging = null"
        >
          <TakeRoll
            :played="currentNotes?.notes ?? []"
            :from="0"
            :to="current.durationSec"
            :height="220"
          />
          <template v-if="phase === 'stopped'">
            <i class="cut" :style="{ left: '0', width: pct(current.trimFrom) }" />
            <i
              class="cut"
              :style="{ left: pct(current.trimTo), width: `calc(100% - ${pct(current.trimTo)})` }"
            />
            <button
              class="handle"
              :style="{ left: pct(current.trimFrom) }"
              aria-label="Trim start"
              @pointerdown="trimDown('trimFrom', $event)"
            />
            <button
              class="handle"
              :style="{ left: pct(current.trimTo) }"
              aria-label="Trim end"
              @pointerdown="trimDown('trimTo', $event)"
            />
          </template>
          <i
            v-if="isPlaying"
            class="playhead"
            :style="{ left: pct(playhead + (phase === 'stopped' ? current.trimFrom : 0)) }"
          />
        </div>
        <p v-if="phase === 'stopped'" class="muted hint">
          Silence trimmed: {{ formatDuration(current.trimFrom) }} at the start,
          {{ formatDuration(current.durationSec - current.trimTo) }} at the end · drag the edges to
          adjust
        </p>
      </div>

      <aside class="save card">
        <h2>{{ phase === 'saved' ? 'Recording' : 'Save recording' }}</h2>
        <label class="field">
          <span>Name</span>
          <input
            v-model="name"
            aria-label="Name"
            @keydown.enter.prevent="phase === 'saved' ? renameSaved() : save()"
            @blur="phase === 'saved' && renameSaved()"
          />
        </label>
        <p v-if="keyName" class="muted">
          Sounds like {{ keyName
          }}<template v-if="current.metronome"> at {{ current.bpm }} bpm</template>
        </p>
        <div v-if="phase === 'stopped' && suggestions.length" class="row">
          <button v-for="s in suggestions" :key="s" class="ghost small" @click="name = s">
            {{ s }}
          </button>
        </div>

        <div class="actions">
          <button v-if="phase === 'stopped'" class="primary" @click="save">
            Save to Recordings <kbd>Enter</kbd>
          </button>
          <button
            v-if="phase === 'saved'"
            class="primary"
            :disabled="adding"
            title="Adds it to the library and opens it for practice"
            @click="practise"
          >
            {{ adding ? 'Adding…' : 'Practise as a piece' }}
          </button>
          <button @click="exportMidi">Export .mid <kbd>E</kbd></button>
          <button
            v-if="phase === 'stopped'"
            class="ghost"
            :class="{ danger: confirmDiscard }"
            @click="discard"
          >
            {{ confirmDiscard ? 'Click again to discard' : 'Discard' }}
          </button>
          <button v-else class="ghost" :class="{ danger: confirmDiscard }" @click="deleteSaved">
            {{ confirmDiscard ? 'Click again to delete' : 'Delete' }}
          </button>
        </div>
        <p class="muted hint">
          <template v-if="phase === 'stopped'"
            >Leaving without saving keeps this as a draft until your next recording.</template
          >
          <template v-else>Saved recordings stay until you delete them, on this device.</template>
          .mid keeps notes, velocity and pedal.
        </p>
      </aside>
    </section>

    <footer class="bar">
      <BackToLibrary />

      <template v-if="phase === 'live'">
        <button
          class="rec-btn"
          :class="{ on: recordingFrom !== null }"
          :aria-label="recordingFrom !== null ? 'Stop recording' : 'Record'"
          :title="recordingFrom !== null ? 'Stop (R)' : 'Record (R)'"
          @click="toggleRecording"
        >
          <i aria-hidden="true" />
        </button>
        <span class="muted">
          <template v-if="recordingFrom !== null">R stops</template>
          <template v-else>R records</template>
        </span>
        <button
          v-if="recordingFrom === null && bufferedSec > 1"
          class="big-btn"
          @click="saveBuffer"
        >
          Keep the last {{ formatDuration(bufferedSec) }}
        </button>
        <span class="spacer" />
        <button
          class="big-btn"
          :aria-pressed="metronome"
          :class="{ active: metronome }"
          title="Metronome (M)"
          @click="toggleMetronome"
        >
          Metronome
        </button>
        <div class="tempo" role="group" aria-label="Metronome tempo">
          <button
            class="ghost"
            aria-label="Slower"
            title="Slower ([)"
            @click="bpm = Math.max(30, bpm - 2)"
          >
            −
          </button>
          <span class="num value"
            ><b>{{ bpm }}</b> <span class="muted">bpm</span></span
          >
          <button
            class="ghost"
            aria-label="Faster"
            title="Faster (])"
            @click="bpm = Math.min(240, bpm + 2)"
          >
            +
          </button>
        </div>
        <div class="segmented" role="group" aria-label="Time signature">
          <button
            v-for="b in BEATS_PER_BAR"
            :key="b"
            :class="{ active: beatsPerBar === b }"
            @click="beatsPerBar = b"
          >
            {{ b }}/4
          </button>
        </div>
      </template>

      <template v-else>
        <button
          class="play-btn"
          :aria-label="isPlaying ? 'Stop' : 'Play'"
          :title="isPlaying ? 'Stop (Space)' : 'Play (Space)'"
          @click="togglePlayback"
        >
          <svg
            v-if="isPlaying"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
          <svg
            v-else
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M7 4.5v15l12-7.5z" />
          </svg>
        </button>
        <span class="num pos"
          ><b>{{ formatDuration(playhead) }}</b>
          <span class="muted">/ {{ formatDuration(keptLength) }}</span></span
        >
        <span class="spacer" />
        <button class="big-btn" @click="newRecording">Record new <kbd>R</kbd></button>
      </template>
    </footer>
  </div>
</template>

<style scoped>
.free {
  height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--bg);
}

.head {
  display: flex;
  align-items: flex-end;
  gap: 24px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--line);
}

.hud {
  display: grid;
  gap: 6px;
}

.hud p {
  margin: 0;
  font-size: 18px;
}

.eyebrow {
  color: var(--muted);
}

.big {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.big b {
  font-size: 56px;
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--hi);
}

.big small {
  font-size: 18px;
  color: var(--muted);
}

.rec-dot {
  align-self: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--danger);
  animation: blink 1.4s ease-in-out infinite;
}

@keyframes blink {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rec-dot {
    animation: none;
  }
}

.side {
  display: grid;
  justify-items: end;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 99px;
  color: var(--muted);
  font-size: 15px;
  text-decoration: none;
}

.status-pill i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text);
}

.status-pill.off i {
  background: var(--faint);
}

.stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
}

canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.toast {
  position: absolute;
  top: 20px;
  left: 50%;
  translate: -50% 0;
}

.toast span {
  display: block;
  padding: 8px 16px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-size: 16px;
}

.review {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
  gap: 32px;
  align-content: start;
  padding: 32px 24px;
  overflow: auto;
}

.overview-wrap {
  display: grid;
  gap: 10px;
  align-content: start;
}

.overview {
  position: relative;
  padding: 12px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  touch-action: none;
}

.cut {
  position: absolute;
  top: 0;
  bottom: 0;
  background: repeating-linear-gradient(135deg, rgb(var(--ink) / 0.1) 0 6px, transparent 6px 12px);
  pointer-events: none;
}

.handle {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 14px;
  margin-left: -7px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: var(--text);
  cursor: ew-resize;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--hi);
}

.save {
  display: grid;
  gap: 14px;
  align-content: start;
}

.save h2 {
  font-size: 22px;
  font-weight: 500;
}

.save p {
  margin: 0;
}

.save input {
  height: 44px;
  font-size: 17px;
}

.actions {
  display: grid;
  gap: 8px;
}

.actions button {
  height: 48px;
  justify-content: center;
  font-size: 17px;
}

button.danger {
  color: var(--danger);
}

.hint {
  font-size: 0.85rem;
  line-height: 1.45;
}

kbd {
  font-family: var(--mono);
  font-size: 0.8em;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid currentColor;
  opacity: 0.8;
}

.bar {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 84px;
  padding: 0 20px;
  border-top: 1px solid var(--line);
  font-size: 18px;
  color: var(--muted);
  white-space: nowrap;
}

.big-btn {
  height: 52px;
  padding: 0 18px;
  font-size: 18px;
  border-radius: 12px;
}

.rec-btn {
  width: 64px;
  height: 64px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
  border: 2px solid var(--border);
  background: transparent;
}

.rec-btn i {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--danger);
  transition:
    border-radius 0.15s,
    width 0.15s,
    height 0.15s;
}

.rec-btn.on i {
  width: 22px;
  height: 22px;
  border-radius: 4px;
}

.play-btn {
  width: 56px;
  height: 56px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
  border: 0;
  background: var(--inv);
  color: var(--inv-text);
}

.pos b {
  font-size: 28px;
  font-weight: 400;
  color: var(--hi);
}

.tempo {
  display: flex;
  align-items: center;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.tempo button {
  width: 46px;
  height: 46px;
  padding: 0;
  justify-content: center;
  border: 0;
  font-size: 1.2rem;
}

.tempo .value {
  min-width: 100px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
}

.tempo b {
  font-size: 28px;
  font-weight: 400;
  color: var(--hi);
}

@media (max-width: 900px) {
  .review {
    grid-template-columns: 1fr;
  }
  .bar {
    flex-wrap: wrap;
    padding: 10px 12px;
  }
}
</style>
