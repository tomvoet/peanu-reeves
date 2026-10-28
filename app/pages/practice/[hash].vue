<script setup lang="ts">
import type { Attempt, Piece, Section, Take } from '#db/schema'
import type { WaitOptions } from '#engine/matcher/matcher'
import { KeyboardInput, isEditable } from '#engine/midi-input/keyboard'
import { planDrill, type DrillStep } from '#engine/modes/drill'
import { DEFAULT_TEMPO_RAMP, type TempoRampConfig } from '#engine/modes/tempo-ramp'
import { HIGHEST, LOWEST, fitRange } from '#engine/render/keyboard-layout'
import { eventsToMidi } from '#engine/recording/export'
import { notesOf, type TakeNote } from '#engine/recording/take'
import { paletteFrom, type Renderer, type ReplayMode } from '#engine/render/renderer'
import type { StaffRenderer } from '#engine/render/staff'
import { assignHands } from '#engine/song/hand-split'
import {
  PracticeSession,
  type PartialTake,
  type PassResult,
  type PracticeConfig,
  type RecordedTake,
  type SessionStatus,
} from '#engine/practice'
import { measureAtTime } from '#engine/song/measures'
import { parseSong } from '#engine/song/parse'
import { worstMeasures } from '#engine/stats/aggregate'
import type { Hand, HandModes, Song } from '#engine/types'

type Mode = 'practice' | 'listen'
type WaitHands = 'both' | Hand
type WaitChord = WaitOptions['chord']
type RampPctKey = 'start' | 'step' | 'target'
type MeasureResult = PassResult['perMeasure'][number]
type SheetTab = 'options' | 'takes'
type TakeFilter = 'loop' | 'piece'

/** The take being replayed, and how. */
interface ReplayState {
  take: Take
  mode: ReplayMode
  /** Starred take to compare against instead of the score. */
  reference: Take | null
  speed: number
  /** Practice tempo to return to afterwards. */
  tempoBefore: number
}

/** Weak-bar drill: loops each step until one clean pass at the ramp's target tempo. */
interface DrillState {
  steps: DrillStep[]
  index: number
}

interface PracticeOptions {
  hands: HandModes
  tempoPct: number
  wait: boolean
  waitChord: WaitChord
  wrongBlocks: boolean
  /** Which hands wait mode holds for. */
  waitHands: WaitHands
  loopOn: boolean
  loopFrom: number
  loopTo: number
  ramp: TempoRampConfig
  hear: Record<Hand, boolean>
  /** Ramp tempo reached per loop range, keyed by "start-end" bar indexes. */
  rampProgress: Record<string, number>
  countIn: number
  metronome: boolean
  lastSec: number
}

/** `?loop=9-12` opens the piece with those bars looped. */
const LOOP_QUERY = /^(\d+)-(\d+)$/
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const
const HANDS = ['L', 'R'] as const satisfies readonly Hand[]
const WAIT_HANDS = ['both', 'L', 'R'] as const satisfies readonly WaitHands[]
const COUNT_INS = [0, 1, 2] as const
const LOOK_AHEADS = [1.5, 2.5, 4] as const
const REPLAY_MODES = [
  { value: 'you', label: 'You', key: '1' },
  { value: 'score', label: 'Score', key: '2' },
  { value: 'both', label: 'Both', key: '3' },
] as const satisfies readonly { value: ReplayMode; label: string; key: string }[]
const REPLAY_SPEEDS = [0.5, 0.75, 1] as const
const takeTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const route = useRoute()
const hash = computed(() => String(route.params.hash))
const repos = useRepos()
const runtime = useRuntime()
const settings = useSettings()
const audio = useAudioStatus()
const midi = useMidiStatus()
const library = useLibrary()
const theme = useTheme()

const piece = ref<Piece>()
const song = shallowRef<Song>()
const sections = ref<Section[]>([])
const loadError = ref<string | null>(null)
const session = shallowRef<PracticeSession>()
const renderer = shallowRef<Renderer>()
const status = ref<SessionStatus | null>(null)
const lastPass = ref<PassResult | null>(null)
const lastPerMeasure = shallowRef<MeasureResult[] | null>(null)
const passHistory = ref<number[]>([])
const showPanel = ref(false)
const sectionLabel = ref('')
const notice = ref<string | null>(null)
const fixingHands = ref(false)
const lastTime = ref<{ accuracy: number | null; tempo: number } | null>(null)
const takes = ref<Take[]>([])
const lastTake = shallowRef<Take | null>(null)
const replay = shallowRef<ReplayState | null>(null)
const sheetTab = ref<SheetTab>('options')
const takeFilter = ref<TakeFilter>('loop')
const openTakeId = ref<string>()
const drill = ref<DrillState | null>(null)

const canvasBox = useTemplateRef<HTMLElement>('canvasBox')
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const staffCanvas = useTemplateRef<HTMLCanvasElement>('staffCanvas')
const staff = shallowRef<StaffRenderer>()

const defaultOptions = {
  hands: { L: 'play', R: 'play' },
  tempoPct: 100,
  wait: false,
  waitChord: 'all',
  wrongBlocks: false,
  waitHands: 'both',
  loopOn: false,
  loopFrom: 1,
  loopTo: 4,
  ramp: { ...DEFAULT_TEMPO_RAMP },
  hear: { L: true, R: true },
  rampProgress: {},
  countIn: 0,
  metronome: false,
  lastSec: 0,
} satisfies PracticeOptions

const opts = useLocalStorage<PracticeOptions>(() => `practice:${hash.value}`, defaultOptions, {
  mergeDefaults: true,
})

const mode = ref<Mode>(route.query.mode === 'listen' ? 'listen' : 'practice')
const listening = computed(() => mode.value === 'listen')

const handModes = computed<HandModes>(() => {
  const o = opts.value
  if (listening.value) return { L: o.hear.L ? 'auto' : 'ghost', R: o.hear.R ? 'auto' : 'ghost' }

  const modes = { ...o.hands }
  // Waiting for one hand: the other hand accompanies by itself instead of being scored.
  if (o.wait && o.waitHands !== 'both') {
    const other: Hand = o.waitHands === 'L' ? 'R' : 'L'
    if (modes[other] === 'play') modes[other] = 'auto'
  }
  return modes
})

const measureCount = computed(() => song.value?.measures.length ?? 1)
const loopRange = computed(() => {
  const last = measureCount.value
  const a = Math.min(Math.max(1, opts.value.loopFrom), last)
  const b = Math.min(Math.max(a, opts.value.loopTo), last)
  return { startMeasure: a - 1, endMeasure: b - 1 }
})
const rampKey = computed(() => `${loopRange.value.startMeasure}-${loopRange.value.endMeasure}`)
const activeSectionId = computed(() =>
  opts.value.loopOn
    ? sections.value.find(
        (s) =>
          s.startMeasure === loopRange.value.startMeasure &&
          s.endMeasure === loopRange.value.endMeasure,
      )?.id
    : undefined,
)
const currentMeasure = computed(() =>
  song.value && status.value ? measureAtTime(song.value.measures, status.value.songTime) + 1 : 1,
)
const baseBpm = computed(() => {
  const m = song.value?.measures[currentMeasure.value - 1]
  return m ? ((m.numerator * 4) / m.denominator / (m.endSec - m.startSec)) * 60 : 120
})
const canPlay = computed(() => audio.ready || !!audio.error)
const playing = computed(() => !!status.value?.playing)
/** Focus mode: while playing, everything but the music steps back. */
const quiet = computed(
  () =>
    settings.focusWhilePlaying &&
    playing.value &&
    !fixingHands.value &&
    !showPanel.value &&
    !replay.value,
)
const timingWindow = computed(() => settings.timingWindowMs)
const presetLabel = computed(() => (timingWindow.value === 35 ? 'Strict ±35 ms' : 'Relaxed ±60 ms'))

const noteName = (p: number) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`
/** Notes wait mode is holding for, lowest first. */
const waitTargets = computed(() => {
  const s = song.value
  const st = status.value
  if (!s || !st?.waiting) return []

  return s.notes
    .filter(
      (n) =>
        handModes.value[n.hand] === 'play' &&
        (opts.value.waitHands === 'both' || opts.value.waitHands === n.hand) &&
        Math.abs(n.startSec - st.songTime) < 0.06,
    )
    .map((n) => ({ name: noteName(n.pitch), hand: n.hand }))
})

const timingLabel = (ms: number | null) => {
  if (ms === null) return '–'
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±'
  const word = Math.abs(ms) <= timingWindow.value ? 'on time' : ms < 0 ? 'early' : 'late'
  return `${sign}${Math.abs(Math.round(ms))} ms ${word}`
}
const meanLabel = (ms: number | null) => {
  if (ms === null) return 'No hits to time'
  const r = Math.round(ms)
  const side = r < 0 ? 'early' : 'late'
  const inside = Math.abs(ms) <= timingWindow.value ? 'inside' : 'outside'
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)} ms ${side} on average · ${inside}`
}

const passMean = computed(() => {
  const d = lastPass.value?.deviations ?? []
  return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null
})
/** 13 bins from -60 to +60 ms. Outliers land in the end bins. */
const histogram = computed(() => {
  const bins = Array.from<number>({ length: 13 }).fill(0)
  for (const d of lastPass.value?.deviations ?? []) {
    bins[Math.min(12, Math.max(0, Math.round(d / 10) + 6))]!++
  }

  const max = Math.max(1, ...bins)
  return bins.map((count, i) => ({
    count,
    height: `${(count / max) * 100}%`,
    inside: Math.abs((i - 6) * 10) <= timingWindow.value,
  }))
})
const insideWindow = computed(
  () => (lastPass.value?.deviations ?? []).filter((d) => Math.abs(d) <= timingWindow.value).length,
)
const worstRange = computed(() =>
  lastPass.value ? worstMeasures(lastPass.value.perMeasure) : null,
)
const drillPlan = computed(() =>
  lastPerMeasure.value
    ? planDrill(lastPerMeasure.value, measureCount.value, opts.value.ramp.threshold)
    : [],
)
const drillStep = computed(() => drill.value?.steps[drill.value.index] ?? null)
const passCardOpen = computed(() => !!lastPass.value && !status.value?.playing && !replay.value)

const takeInLoop = (t: Take): boolean =>
  t.startMeasure === loopRange.value.startMeasure && t.endMeasure === loopRange.value.endMeasure
const shownTakes = computed(() => {
  const list =
    takeFilter.value === 'loop' && opts.value.loopOn ? takes.value.filter(takeInLoop) : takes.value
  return { starred: list.filter((t) => t.starred), recent: list.filter((t) => !t.starred) }
})
const loopTakeCount = computed(() => takes.value.filter(takeInLoop).length)
const bestStarred = computed(() =>
  takes.value
    .filter((t) => t.starred && t.id !== replay.value?.take.id)
    .toSorted((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0))
    .at(0),
)
const replayNotes = computed<readonly TakeNote[]>(() =>
  replay.value ? notesOf(replay.value.take.events).notes : [],
)
const lastTakeNotes = computed<readonly TakeNote[]>(() =>
  lastTake.value ? notesOf(lastTake.value.events).notes : [],
)
const replayElapsed = computed(() => {
  const r = replay.value
  const t = status.value?.songTime ?? 0
  if (!r) return null
  const real = (s: number): number => s / r.take.tempo
  return {
    at: formatDuration(real(Math.max(0, t - r.take.fromSec))),
    total: formatDuration(real(r.take.toSec - r.take.fromSec)),
  }
})

const midiLabel = computed(() => {
  if (!midi.supported) return 'Web MIDI unavailable'
  if (!midi.connected) return midi.permission === 'denied' ? 'MIDI blocked' : 'Connect MIDI'
  if (!midi.devices.length)
    return settings.keyboardInput ? 'No MIDI device · computer keys' : 'No MIDI device'

  const picked = midi.devices.find((d) => d.id === settings.midiDeviceId)
  if (picked) return picked.name
  const [only] = midi.devices
  return midi.devices.length === 1 && only ? only.name : `${midi.devices.length} MIDI devices`
})

const activeRamp = (): TempoRampConfig => ({
  ...opts.value.ramp,
  enabled: (opts.value.ramp.enabled || !!drill.value) && opts.value.loopOn,
})
const rampFrom = (): number | null => opts.value.rampProgress[rampKey.value] ?? null
const shownTempoPct = computed(() =>
  activeRamp().enabled && status.value ? Math.round(status.value.tempo * 100) : opts.value.tempoPct,
)
const rampPct = (key: RampPctKey) =>
  computed({
    get: () => Math.round(opts.value.ramp[key] * 100),
    set: (v: number) => (opts.value.ramp[key] = v / 100),
  })
const rampStart = rampPct('start')
const rampStep = rampPct('step')
const rampTarget = rampPct('target')
const rampThreshold = computed({
  get: () => Math.round(opts.value.ramp.threshold * 100),
  set: (v: number) => (opts.value.ramp.threshold = v / 100),
})

async function load() {
  try {
    await library.ready
    piece.value = await repos.pieces.get(hash.value)
    if (!piece.value) throw new Error('This piece is not in the library.')

    const [data, override] = await Promise.all([
      library.loadBytes(piece.value),
      repos.overrides.get(hash.value),
    ])
    song.value = parseSong(data, { title: piece.value.title, handSplit: override?.handSplit })

    const linked = LOOP_QUERY.exec(String(route.query.loop ?? ''))
    if (linked) setLoop(Number(linked[1]) - 1, Number(linked[2]) - 1)

    sections.value = await repos.sections.forPiece(hash.value)
    seedHistory(await repos.attempts.forPiece(hash.value))
    if (route.query.drill) startDrill(false)
    await loadTakes()
    lastTake.value = takes.value[0] ?? null
    void repos.pieces.touch(hash.value)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

function sessionConfig(): PracticeConfig {
  const o = opts.value
  const ramp = activeRamp()
  return {
    handModes: handModes.value,
    tempo: ramp.enabled ? Math.max(ramp.start, rampFrom() ?? 0) : o.tempoPct / 100,
    toleranceMs: settings.toleranceMs,
    offsetMs: settings.inputOffsetMs,
    lookahead: settings.lookahead,
    wait:
      o.wait && !listening.value
        ? {
            chord: o.waitChord,
            wrongBlocks: o.wrongBlocks,
            hands: o.waitHands === 'both' ? undefined : [o.waitHands],
          }
        : null,
    loop: o.loopOn ? loopRange.value : null,
    ramp,
    rampFrom: rampFrom(),
    scoring: !listening.value,
    replay: null,
    countIn: o.countIn,
    metronome: o.metronome,
  }
}

watch([song, canvas], ([s, el]) => {
  const box = canvasBox.value
  if (!s || !el || !box || session.value) return

  const created = new PracticeSession(
    s,
    runtime.piano,
    runtime.input,
    sessionConfig(),
    runtime.clock.now,
  )
  renderer.value = created.attach(el)
  renderer.value.resize(box.clientWidth, box.clientHeight)

  created.hooks.hook('pass', onPass)
  created.hooks.hook('partialTake', (take) => void saveTake(take, take))
  created.hooks.hook('replayEnd', () => flash('End of the take'))
  created.hooks.hook('idle', () => flash('Not scored: no notes were played'))
  created.hooks.hook('tempo', (t) => {
    if (created.rampTempo === null) return
    const before = opts.value.rampProgress[rampKey.value]
    opts.value.rampProgress[rampKey.value] = t
    if (before !== undefined && Math.abs(before - t) > 1e-3)
      flash(`Tempo ramp: ${t > before ? 'up' : 'down'} to ${Math.round(t * 100)}%`)
  })

  const resumeAt = opts.value.lastSec
  if (!opts.value.loopOn && resumeAt > 0 && resumeAt < s.durationSec - 1) {
    created.seek(s.measures[measureAtTime(s.measures, resumeAt)]?.startSec ?? 0)
  }
  session.value = created
})

watch([session, staffCanvas], ([s, el]) => {
  if (!s) return
  s.detachStaff()
  staff.value = el ? s.attachStaff(el) : undefined
  if (el) staff.value?.resize(el.clientWidth, el.clientHeight)
})

useResizeObserver(staffCanvas, ([entry]) => {
  if (entry) staff.value?.resize(entry.contentRect.width, entry.contentRect.height)
})

// Post flush: app.vue sets data-theme in a pre-flush watcher, so the CSS variables are current here.
watch(
  [renderer, staff, theme],
  ([r, st]) => {
    const palette = paletteFrom(document.documentElement)
    if (r) r.options.palette = palette
    if (st) st.palette = palette
  },
  { flush: 'post' },
)

watchEffect(() => {
  const r = renderer.value
  if (!r || !song.value) return

  r.options.timingWindowMs = settings.timingWindowMs
  r.options.labels = settings.noteLabels
  const [low, high] = settings.fitKeyboard
    ? fitRange(song.value.notes.map((n) => n.pitch))
    : [LOWEST, HIGHEST]
  r.setRange(low, high)
})

useResizeObserver(canvasBox, ([entry]) => {
  if (entry) renderer.value?.resize(entry.contentRect.width, entry.contentRect.height)
})

useIntervalFn(() => (status.value = session.value?.status ?? null), 80)

watch(
  session,
  async (s) => {
    const id = route.query.take
    if (!s || typeof id !== 'string' || !id) return
    const take = await repos.takes.get(id)
    if (take?.hash === hash.value) startReplay(take, 'you', false)
  },
  { once: true },
)

watch(
  session,
  (s) => {
    if (s && route.query.takes) openTakes()
  },
  { once: true },
)

watch(mode, (m) => navigateTo({ query: m === 'listen' ? { mode: m } : {} }, { replace: true }))
watch(handModes, (h) => session.value?.update({ handModes: h }))
watch(listening, (on) => {
  const { scoring, wait } = sessionConfig()
  if (on) lastPass.value = null
  session.value?.update({ scoring, wait })
})
watch(
  () => [opts.value.countIn, opts.value.metronome] as const,
  ([countIn, metronome]) => session.value?.update({ countIn, metronome }),
)
watch(
  () => opts.value.tempoPct,
  (pct) => {
    if (session.value && Math.abs(session.value.status.tempo * 100 - pct) > 0.5)
      session.value.setTempo(pct / 100)
  },
)
watch(
  () =>
    [opts.value.wait, opts.value.waitChord, opts.value.wrongBlocks, opts.value.waitHands] as const,
  () => session.value?.update({ wait: sessionConfig().wait }),
)
watch([() => opts.value.loopOn, loopRange], ([on, r]) => {
  const step = drillStep.value
  if (step && (!on || r.startMeasure !== step.startMeasure || r.endMeasure !== step.endMeasure))
    stopDrill()

  session.value?.update({ loop: sessionConfig().loop, rampFrom: rampFrom() })
})
watch(
  activeRamp,
  (ramp) => {
    session.value?.update({ ramp, rampFrom: rampFrom() })
    if (!ramp.enabled) session.value?.setTempo(opts.value.tempoPct / 100)
  },
  { deep: true },
)
watch(
  () => [settings.toleranceMs, settings.inputOffsetMs, settings.lookahead] as const,
  () =>
    session.value?.update({
      toleranceMs: settings.toleranceMs,
      offsetMs: settings.inputOffsetMs,
      lookahead: settings.lookahead,
    }),
)

watch(playing, (now, was) => {
  if (was && !now) rememberPosition()
  if (now && settings.focusWhilePlaying) showPanel.value = false
})

const visibility = useDocumentVisibility()
watch(visibility, (v) => {
  if (v !== 'hidden') return
  session.value?.pause()
  runtime.piano.allNotesOff()
})

watch(
  () => midi.devices.length,
  (n, was) => {
    if (n >= was || !status.value?.playing) return
    session.value?.pause()
    runtime.piano.allNotesOff()
    flash('MIDI keyboard disconnected. Playback paused.')
  },
)

const { start: startNoticeTimer } = useTimeoutFn(() => (notice.value = null), 3500, {
  immediate: false,
})
function flash(text: string) {
  notice.value = text
  startNoticeTimer()
}

function rememberPosition() {
  const t = session.value?.status.songTime
  if (t !== undefined) opts.value.lastSec = Math.max(0, t)
}

function seedHistory(attempts: Attempt[]) {
  const latest = attempts[0]
  if (latest) lastTime.value = { accuracy: latest.accuracy, tempo: latest.tempoFactor }

  passHistory.value = attempts
    .slice(0, 12)
    .map((a) => a.accuracy)
    .filter((a): a is number => a !== null)
    .toReversed()

  // Latest known result for every bar, across recent passes.
  const seen = new Map<number, MeasureResult>()
  for (const a of attempts.slice(0, 50))
    for (const m of a.perMeasure)
      if (m.accuracy !== null && !seen.has(m.measure)) seen.set(m.measure, m)
  if (seen.size) lastPerMeasure.value = [...seen.values()]
}

function onPass(result: PassResult) {
  lastPass.value = result
  const step = drillStep.value
  if (
    step &&
    result.loop?.startMeasure === step.startMeasure &&
    result.loop.endMeasure === step.endMeasure &&
    result.accuracy !== null &&
    result.accuracy >= opts.value.ramp.threshold &&
    result.tempo >= opts.value.ramp.target - 1e-3
  )
    nextDrillStep(true)

  lastPerMeasure.value = result.perMeasure
  if (result.accuracy !== null)
    passHistory.value = [...passHistory.value.slice(-11), result.accuracy]

  void repos.attempts
    .add({
      hash: hash.value,
      sectionId: activeSectionId.value,
      startedAt: result.startedAt,
      tempoFactor: result.tempo,
      mode: result.wait ? 'wait' : 'normal',
      hands: result.handModes,
      startMeasure: result.loop?.startMeasure,
      endMeasure: result.loop?.endMeasure,
      accuracy: result.accuracy,
      meanDevMs: result.meanDevMs,
      notes: result.notes,
      perMeasure: result.perMeasure,
    })
    .then((attemptId) => saveTake(result.take, { ...result, attemptId }))
}

async function loadTakes(): Promise<void> {
  takes.value = await repos.takes.forPiece(hash.value)
}

/** Keeps what was played during a pass so it can be listened to and compared later. */
async function saveTake(
  take: RecordedTake,
  meta: Pick<PartialTake, 'startedAt' | 'tempo' | 'loop' | 'accuracy'> & { attemptId?: string },
): Promise<void> {
  const record: Omit<Take, 'id'> = {
    hash: hash.value,
    attemptId: meta.attemptId,
    startedAt: meta.startedAt,
    startMeasure: meta.loop?.startMeasure,
    endMeasure: meta.loop?.endMeasure,
    fromSec: take.fromSec,
    toSec: take.toSec,
    tempo: meta.tempo,
    accuracy: meta.accuracy,
    starred: 0,
    events: structuredClone(toRaw(take.events)),
  }
  const id = await repos.takes.add(record)
  lastTake.value = { ...record, id }
  await loadTakes()
}

function startReplay(take: Take, replayMode: ReplayMode = 'you', autoplay = true): void {
  const s = session.value
  if (!s) return

  s.pause()
  lastPass.value = null
  fixingHands.value = false
  const tempoBefore = replay.value?.tempoBefore ?? s.status.tempo
  replay.value = { take, mode: replayMode, reference: null, speed: 1, tempoBefore }
  applyReplay()
  if (autoplay) s.play()
}

function applyReplay(): void {
  const s = session.value
  const r = replay.value
  if (!s || !r) return

  const { notes, pedal } = notesOf(r.take.events)
  s.update({
    replay: {
      notes,
      pedal,
      tempo: r.take.tempo,
      from: r.take.fromSec,
      to: r.take.toSec,
      mode: r.mode,
      reference: r.reference ? notesOf(r.reference.events).notes : null,
    },
  })
  s.setTempo(r.take.tempo * r.speed)
}

function setReplay(patch: Partial<Pick<ReplayState, 'mode' | 'reference' | 'speed'>>): void {
  if (!replay.value) return
  const wasPlaying = playing.value
  replay.value = { ...replay.value, ...patch }
  applyReplay()
  if (wasPlaying) session.value?.play()
}

/** Back to practising, where the take started. */
function exitReplay(): void {
  const s = session.value
  const r = replay.value
  if (!s || !r) return

  s.pause()
  replay.value = null
  s.update({ replay: null })
  s.setTempo(r.tempoBefore)
  s.seek(r.take.fromSec)
}

/** Tab on the pass summary or during a replay: hear the score or your take from the same spot. */
function swapReplaySound(): void {
  const r = replay.value
  if (r) setReplay({ mode: r.mode === 'score' ? 'you' : 'score' })
  else if (lastTake.value) startReplay(lastTake.value, 'score')
}

async function toggleStar(take: Take): Promise<void> {
  if (take.id === undefined) return
  const starred = !take.starred
  await repos.takes.setStarred(take.id, starred)
  const update = (t: Take | null): Take | null =>
    t && t.id === take.id ? { ...t, starred: starred ? 1 : 0 } : t
  lastTake.value = update(lastTake.value)
  if (replay.value)
    replay.value = { ...replay.value, take: update(replay.value.take) ?? replay.value.take }
  await loadTakes()
  flash(starred ? 'Take starred: kept forever' : 'Star removed')
}

async function deleteTake(take: Take): Promise<void> {
  if (take.id === undefined) return
  if (replay.value?.take.id === take.id) exitReplay()
  await repos.takes.remove(take.id)
  if (lastTake.value?.id === take.id) lastTake.value = null
  await loadTakes()
}

function exportTake(take: Take): void {
  const title = piece.value?.title ?? 'Take'
  const name = `${title}, ${takeTimeFmt.format(take.startedAt)}`
  const bytes = eventsToMidi(take.events, { name, timeScale: take.tempo, bpm: baseBpm.value })
  downloadFile(`${safeFileName(name)}.mid`, 'audio/midi', bytes)
}

function openTakes(): void {
  showPanel.value = true
  sheetTab.value = 'takes'
}

function takeLabel(t: Take): string {
  const bars =
    t.startMeasure === undefined
      ? 'whole piece'
      : `bars ${t.startMeasure + 1}–${(t.endMeasure ?? t.startMeasure) + 1}`
  const length = formatDuration((t.toSec - t.fromSec) / t.tempo)
  return `${bars} · ${Math.round(t.tempo * 100)}% · ${length}`
}

function primaryPassAction() {
  if (worstRange.value) loopWorst()
  lastPass.value = null
  session.value?.play()
}

function loopWorst() {
  const worst = lastPass.value && worstMeasures(lastPass.value.perMeasure)
  if (worst) setLoop(worst.startMeasure, worst.endMeasure)
  lastPass.value = null
}

function startDrill(autoplay = true): void {
  const steps = drillPlan.value
  const first = steps[0]
  if (!first) return flash('No weak bars to drill')

  drill.value = { steps, index: 0 }
  lastPass.value = null
  mode.value = 'practice'
  setLoop(first.startMeasure, first.endMeasure)
  if (autoplay) void nextTick(() => session.value?.play())
  else
    flash(
      `Drilling ${steps.length} weak ${steps.length === 1 ? 'spot' : 'spots'}. Press Space to start`,
    )
}

function nextDrillStep(cleared: boolean): void {
  const d = drill.value
  if (!d) return
  const done = d.steps[d.index]!
  const next = d.steps[d.index + 1]
  if (!next) {
    stopDrill()
    if (cleared) {
      session.value?.pause()
      flash(`Drill done: every weak spot is clean at ${Math.round(opts.value.ramp.target * 100)}%`)
    }
    return
  }

  drill.value = { ...d, index: d.index + 1 }
  setLoop(next.startMeasure, next.endMeasure)
  const bars = (s: DrillStep) => `bars ${s.startMeasure + 1}–${s.endMeasure + 1}`
  flash(cleared ? `${bars(done)} clean. Next: ${bars(next)}` : `Next: ${bars(next)}`)
}

function stopDrill(): void {
  drill.value = null
}

function restart() {
  lastPass.value = null
  session.value?.seek(
    opts.value.loopOn ? (song.value?.measures[loopRange.value.startMeasure]?.startSec ?? 0) : 0,
  )
  session.value?.play()
}

function practiceFromHere() {
  const s = session.value
  if (!s || !song.value) return

  s.pause()
  const start = song.value.measures[currentMeasure.value - 1]?.startSec ?? 0
  lastPass.value = null
  mode.value = 'practice'

  void nextTick(() => {
    s.seek(start)
    s.update({ countIn: Math.max(1, opts.value.countIn) })
    s.play()
    s.update({ countIn: opts.value.countIn })
  })
}

function setLoop(startMeasure: number, endMeasure: number) {
  opts.value.loopFrom = startMeasure + 1
  opts.value.loopTo = endMeasure + 1
  opts.value.loopOn = true
}

function commitLoopField(which: 'loopFrom' | 'loopTo', e: Event) {
  const input = e.target
  if (!(input instanceof HTMLInputElement)) return

  const clamp = (v: number) => Math.min(Math.max(1, Math.round(v) || 1), measureCount.value)
  const next = { loopFrom: opts.value.loopFrom, loopTo: opts.value.loopTo }
  next[which] = clamp(Number(input.value))
  opts.value.loopFrom = Math.min(next.loopFrom, next.loopTo)
  opts.value.loopTo = Math.max(next.loopFrom, next.loopTo)

  input.value = String(opts.value[which])
}

function selectMeasure(measure: number, extend: boolean) {
  if (extend && opts.value.loopOn) {
    const r = loopRange.value
    setLoop(Math.min(r.startMeasure, measure), Math.max(r.endMeasure, measure))
  } else setLoop(measure, measure)
}

function loopHere() {
  const m = currentMeasure.value - 1
  setLoop(m, m)
}

function clearLoop(seekTo?: number) {
  opts.value.loopOn = false
  if (seekTo === undefined) return
  session.value?.update({ loop: null })
  session.value?.seek(seekTo)
}

async function saveSection() {
  const r = loopRange.value
  await repos.sections.add({
    hash: hash.value,
    ...r,
    label: sectionLabel.value.trim() || `Bars ${r.startMeasure + 1}–${r.endMeasure + 1}`,
  })
  sectionLabel.value = ''
  sections.value = await repos.sections.forPiece(hash.value)
}

async function deleteSection(id: string | undefined) {
  if (id === undefined) return
  await repos.sections.remove(id)
  sections.value = await repos.sections.forPiece(hash.value)
}

function restartRamp() {
  delete opts.value.rampProgress[rampKey.value]
  session.value?.update({ loop: sessionConfig().loop, rampFrom: null })
}

function changeTempo(delta: number) {
  if (activeRamp().enabled) return
  opts.value.tempoPct = Math.min(150, Math.max(25, opts.value.tempoPct + delta))
}

function seekMeasure(delta: number) {
  const s = song.value
  const current = session.value
  const live = current?.status.songTime
  if (!s || !current || live === undefined) return

  // From the live position, so quick repeated presses each move a bar.
  const index = measureAtTime(s.measures, live)
  const target = s.measures[Math.max(0, Math.min(index + delta, s.measures.length - 1))]
  if (target) current.seek(target.startSec)
}

function toggleFocus() {
  settings.focusWhilePlaying = !settings.focusWhilePlaying
  flash(settings.focusWhilePlaying ? 'Focus while playing: on' : 'Focus while playing: off')
}

function toggleStaff() {
  settings.showStaff = !settings.showStaff
}

function toggleFixHands() {
  fixingHands.value = !fixingHands.value
  if (fixingHands.value) session.value?.pause()
}

async function fixHandAt(e: MouseEvent) {
  const s = song.value
  const id = fixingHands.value ? renderer.value?.noteAt(e.offsetX, e.offsetY) : null
  const note = id ? s?.notes.find((n) => n.id === id) : undefined
  if (!s || !id || !note) return

  const fixes: Record<string, Hand> = { ...s.handSplit.fixes, [id]: note.hand === 'L' ? 'R' : 'L' }
  const split = { ...s.handSplit, fixes }
  const hands = assignHands(s.notes, split)
  let moved = 0
  s.notes.forEach((n, i) => {
    const hand = hands[i] ?? n.hand
    if (n.hand !== hand) moved++
    n.hand = hand
  })
  s.handSplit = split
  session.value?.update({ handModes: handModes.value })
  staff.value?.relayout()

  const override = await repos.overrides.get(hash.value)
  await repos.overrides.put({
    ...override,
    hash: hash.value,
    handSplit: JSON.parse(JSON.stringify({ ...(override?.handSplit ?? { mode: 'auto' }), fixes })),
  })

  flash(
    `Moved to the ${fixes[id] === 'L' ? 'left' : 'right'} hand` +
      (moved > 1 ? ` (${moved - 1} more ${moved === 2 ? 'note follows' : 'notes follow'})` : ''),
  )
}

function shortcut(e: KeyboardEvent, action: () => void) {
  if (isEditable(e.target)) return
  // Keys that also play notes on the computer keyboard need Alt while it is on.
  const playsNote = settings.keyboardInput && KeyboardInput.pitchOffset(e.code) !== null
  if (playsNote !== e.altKey) return

  e.preventDefault()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  action()
}

const byCode = (code: string, action: () => void, when = () => true) =>
  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if (e.code === code && !e.repeat && when()) shortcut(e, action)
  })

onKeyStroke(' ', (e) =>
  shortcut(e, () => {
    if (!canPlay.value) return
    if (passCardOpen.value) lastPass.value = null
    session.value?.toggle()
  }),
)
onKeyStroke('Enter', (e) => passCardOpen.value && shortcut(e, primaryPassAction))
onKeyStroke('Escape', (e) => {
  if (replay.value) shortcut(e, exitReplay)
  else if (passCardOpen.value) shortcut(e, () => (lastPass.value = null))
  else if (opts.value.loopOn) shortcut(e, () => clearLoop())
})
onKeyStroke('Tab', (e) => {
  if (replay.value || (passCardOpen.value && lastTake.value)) shortcut(e, swapReplaySound)
})
onKeyStroke('Home', (e) => shortcut(e, () => session.value?.seek(0)))
onKeyStroke(['f', 'F'], (e) => !e.repeat && shortcut(e, toggleFocus))
onKeyStroke('ArrowLeft', (e) => shortcut(e, () => seekMeasure(-1)))
onKeyStroke('ArrowRight', (e) => shortcut(e, () => seekMeasure(1)))
onKeyStroke('ArrowUp', (e) => shortcut(e, () => changeTempo(5)))
onKeyStroke('ArrowDown', (e) => shortcut(e, () => changeTempo(-5)))
byCode('KeyO', () => (showPanel.value = !showPanel.value))
byCode('KeyN', toggleStaff)
byCode('KeyL', loopHere, () => !playing.value)
byCode('KeyR', restart, () => !replay.value)
byCode(
  'KeyP',
  () => lastTake.value && startReplay(lastTake.value),
  () => passCardOpen.value,
)
byCode(
  'KeyV',
  () => lastTake.value && startReplay(lastTake.value, 'both'),
  () => passCardOpen.value,
)
byCode(
  'KeyS',
  () => {
    const take = replay.value?.take ?? lastTake.value
    if (take) void toggleStar(take)
  },
  () => !!replay.value || passCardOpen.value,
)
byCode('KeyT', openTakes)
for (const m of REPLAY_MODES) {
  byCode(
    `Digit${m.key}`,
    () => setReplay({ mode: m.value }),
    () => !!replay.value,
  )
}
byCode('BracketLeft', () => changeTempo(-5))
byCode('BracketRight', () => changeTempo(5))

const remoteOffs = [
  runtime.remote.on('toggle', () => canPlay.value && session.value?.toggle()),
  runtime.remote.on('restart', restart),
  runtime.remote.on('prevBar', () => seekMeasure(-1)),
  runtime.remote.on('nextBar', () => seekMeasure(1)),
  runtime.remote.on('slower', () => changeTempo(-5)),
  runtime.remote.on('faster', () => changeTempo(5)),
]

// Keeps the screen on while practising. Released when leaving the page, renewed on return to the tab.
const wakeLock = useWakeLock()

onMounted(() => {
  void wakeLock.request('screen').catch(() => {})
  void load()
})
onBeforeUnmount(() => {
  remoteOffs.forEach((off) => off())
  rememberPosition()
  session.value?.dispose()
})
</script>

<template>
  <div class="practice" :class="{ quiet, paused: !playing }">
    <header class="head" :class="{ ruler: !quiet }">
      <TransportBar
        v-if="song"
        :variant="quiet ? 'hairline' : 'ruler'"
        :measures="song.measures"
        :duration="song.durationSec"
        :time="status?.songTime ?? 0"
        :loop="opts.loopOn ? loopRange : null"
        :heat="listening ? null : lastPerMeasure"
        @seek="session?.seek($event)"
        @loop="setLoop($event.startMeasure, $event.endMeasure)"
        @clear-loop="clearLoop"
      />

      <div v-if="!quiet && !playing && song && !passCardOpen" class="loop-row">
        <template v-if="drill && drillStep">
          <span
            >Drill
            <b class="num">{{ drill.index + 1 }} of {{ drill.steps.length }}</b>
            · bars {{ drillStep.startMeasure + 1 }}–{{ drillStep.endMeasure + 1 }} · one clean pass
            at {{ Math.round(opts.ramp.target * 100) }}% moves on</span
          >
          <button class="ghost small" @click="nextDrillStep(false)">Skip</button>
          <button class="ghost small" @click="stopDrill">Stop drill</button>
        </template>
        <template v-else-if="opts.loopOn">
          <span
            >Loop
            <b class="num">bars {{ loopRange.startMeasure + 1 }}–{{ loopRange.endMeasure + 1 }}</b>
            · drag the edges or across the ruler</span
          >
          <button class="ghost small" title="Stop looping (Esc)" @click="clearLoop()">
            Clear loop
          </button>
        </template>
        <span v-else>Drag across the ruler to loop bars, or press L to loop this bar</span>
        <span class="spacer" />
        <button
          v-if="!drill && !listening && drillPlan.length"
          class="ghost small"
          title="Loop each weak spot with the tempo ramp until it is clean"
          @click="startDrill()"
        >
          Drill weak bars
        </button>
        <span v-if="lastPerMeasure" class="legend"><i />trouble</span>
      </div>

      <div v-if="!quiet && !passCardOpen" class="head-row">
        <div class="hud" :data-testid="listening ? undefined : 'live-stats'">
          <template v-if="replay">
            <div class="big num">
              <b>{{
                replay.take.accuracy === null ? '–' : Math.round(replay.take.accuracy * 100)
              }}</b
              ><span>%</span>
              <small>your take</small>
            </div>
            <div class="replay-legend">
              <span><i class="swatch outline" aria-hidden="true" />score</span>
              <span><i class="swatch filled" aria-hidden="true" />you, brighter = louder</span>
              <span><i class="swatch pedal" aria-hidden="true" />pedal</span>
            </div>
          </template>
          <template v-else-if="listening">
            <div class="big num">
              <b>{{ currentMeasure }}</b
              ><span>/ {{ measureCount }}</span>
              <small>bar · listening</small>
            </div>
          </template>
          <template v-else-if="status">
            <div class="big num">
              <b>{{ status.accuracy === null ? '–' : Math.round(status.accuracy * 100) }}</b
              ><span>%</span>
              <small>{{
                status.waiting ? 'notes' : playing ? 'accuracy' : 'accuracy · paused'
              }}</small>
            </div>
            <template v-if="!quiet">
              <div class="counts num">
                <span title="Hits"
                  ><b>{{ status.counts.hit }}</b
                  >hit</span
                >
                <span title="Wrong notes"
                  ><b>{{ status.counts.wrong }}</b
                  ><i class="x" aria-hidden="true" />wrong</span
                >
                <span title="Missed notes"
                  ><b>{{ status.counts.miss }}</b
                  ><i class="ring" aria-hidden="true" />missed</span
                >
              </div>
              <div v-if="status.waiting" class="timing-line">Timing off while waiting</div>
              <div v-else class="timing-line" title="Last note timing">
                <span class="meter" aria-hidden="true">
                  <i class="band" :style="{ width: `${(timingWindow / 75) * 100}%` }" />
                  <i class="zero" />
                  <i
                    v-if="status.lastDeviationMs !== null"
                    class="knob"
                    :style="{
                      left: `${50 + Math.max(-50, Math.min(50, (status.lastDeviationMs / 75) * 50))}%`,
                    }"
                  />
                </span>
                <span
                  ><b>{{ timingLabel(status.lastDeviationMs) }}</b> · {{ presetLabel }}</span
                >
              </div>
            </template>
          </template>
        </div>
        <span class="spacer" />
        <div v-if="replay" class="side">
          <div class="modes replay-modes" role="radiogroup" aria-label="Show">
            <button
              v-for="m in REPLAY_MODES"
              :key="m.value"
              role="radio"
              :aria-checked="replay.mode === m.value"
              :title="`${m.label} (${m.key})`"
              @click="setReplay({ mode: m.value })"
            >
              {{ m.label }}
            </button>
          </div>
          <div v-if="bestStarred && replay.mode !== 'you'" class="compare-with">
            <span class="muted">Compare with</span>
            <div class="segmented">
              <button
                :class="{ active: !replay.reference }"
                @click="setReplay({ reference: null })"
              >
                Score
              </button>
              <button
                :class="{ active: !!replay.reference }"
                :title="`Starred take, ${formatPercent(bestStarred.accuracy)}`"
                @click="setReplay({ reference: bestStarred })"
              >
                Best starred take
              </button>
            </div>
          </div>
        </div>
        <div v-else-if="!showPanel" class="side">
          <div v-if="!listening" class="strip">
            <button :aria-pressed="opts.wait" @click="opts.wait = !opts.wait">
              Wait {{ opts.wait ? 'on' : 'off' }}
            </button>
            <button :aria-pressed="opts.metronome" @click="opts.metronome = !opts.metronome">
              Metronome
            </button>
            <button :aria-pressed="opts.countIn > 0" @click="opts.countIn = (opts.countIn + 1) % 3">
              Count-in
              {{ opts.countIn ? `${opts.countIn} bar${opts.countIn > 1 ? 's' : ''}` : 'off' }}
            </button>
            <button
              :aria-pressed="true"
              @click="settings.timingWindowMs = settings.timingWindowMs === 35 ? 60 : 35"
            >
              {{ presetLabel }}
            </button>
          </div>
          <div class="device">
            <button
              v-if="midi.supported && !midi.connected && midi.permission !== 'denied'"
              class="status-pill off"
              title="Chrome will ask for permission to use MIDI devices"
              @click="midi.connect()"
            >
              <i />Connect MIDI
            </button>
            <NuxtLink
              v-else
              to="/settings"
              class="status-pill"
              :class="{ off: !midi.devices.length }"
              :title="`${midiLabel}. Open settings to change the input.`"
              ><i />{{ midiLabel }}</NuxtLink
            >
            <button
              v-if="audio.error || audio.state !== 'running'"
              class="status-pill warn"
              @click="runtime.ctx.resume()"
            >
              <i />{{ audio.error ? 'Piano failed to load' : 'Click to enable sound' }}
            </button>
          </div>
        </div>
      </div>
    </header>

    <canvas
      v-if="settings.showStaff && song"
      ref="staffCanvas"
      class="staff"
      data-testid="staff"
      aria-hidden="true"
    />

    <div ref="canvasBox" class="stage">
      <canvas ref="canvas" :class="{ fixing: fixingHands }" @click="fixHandAt" />

      <div v-if="quiet" class="hud float" :data-testid="listening ? undefined : 'live-stats'">
        <div v-if="listening" class="big num">
          <b>{{ currentMeasure }}</b
          ><span>/ {{ measureCount }}</span>
        </div>
        <div v-else-if="status" class="big num">
          <b>{{ status.accuracy === null ? '–' : Math.round(status.accuracy * 100) }}</b
          ><span>%</span>
          <small>{{ status.waiting ? 'notes' : 'accuracy' }}</small>
        </div>
      </div>

      <div v-if="loadError" class="overlay">
        <p class="notice error">{{ loadError }}</p>
        <NuxtLink to="/" class="btn">Back to library</NuxtLink>
      </div>
      <div v-else-if="!audio.ready && !audio.error" class="overlay">
        <p>Loading piano samples…</p>
        <progress :value="audio.loaded" :max="audio.total || 1" />
      </div>
      <div v-else-if="fixingHands" class="chip">
        Click a note to move it to the other hand
        <button class="ghost small" @click="fixingHands = false">Done</button>
      </div>
      <div v-else-if="status?.countingIn" class="chip">Count-in…</div>
      <div v-else-if="status?.waiting" class="chip" role="status">
        Waiting for
        <span v-for="(t, i) in waitTargets" :key="i" class="target num">
          <i :class="t.hand" aria-hidden="true" />{{ t.name }}
        </span>
      </div>

      <div class="toast" aria-live="polite">
        <span v-if="notice">{{ notice }}</span>
        <span v-else-if="lastPass && playing" class="num">
          Pass · <b>{{ formatPercent(lastPass.accuracy) }}</b> · {{ lastPass.notes.wrong }} wrong ·
          {{ lastPass.notes.miss }} missed · {{ Math.round(lastPass.tempo * 100) }}%
        </span>
      </div>

      <section
        v-if="passCardOpen && lastPass"
        class="complete"
        role="dialog"
        aria-labelledby="pass-title"
        data-testid="pass-summary"
      >
        <div class="verdict">
          <span id="pass-title" class="eyebrow"
            >Pass complete · {{ piece?.title }} ·
            {{
              lastPass.loop
                ? `bars ${lastPass.loop.startMeasure + 1}–${lastPass.loop.endMeasure + 1}`
                : 'whole piece'
            }}</span
          >
          <div class="score num big">
            <b>{{ lastPass.accuracy === null ? '–' : Math.round(lastPass.accuracy * 100) }}</b
            ><span>%</span>
          </div>
          <p class="muted">
            accuracy at <b>{{ Math.round(lastPass.tempo * 100) }}% tempo</b> ·
            {{ Math.round((baseBpm * lastPass.tempo * 100) / 100) }} bpm{{
              lastPass.wait ? ' · wait mode' : ''
            }}
          </p>
          <div class="counts num">
            <span
              ><b>{{ lastPass.notes.hit }}</b
              >hit</span
            >
            <span
              ><b>{{ lastPass.notes.wrong }}</b
              ><i class="x" aria-hidden="true" />wrong</span
            >
            <span
              ><b>{{ lastPass.notes.miss }}</b
              ><i class="ring" aria-hidden="true" />missed</span
            >
          </div>
          <p v-if="status?.ramp" class="ramp-note">
            <span class="dots" aria-hidden="true">
              <i
                v-for="i in opts.ramp.cleanPasses"
                :key="i"
                :class="{ on: i <= status.ramp.cleanStreak }"
              />
            </span>
            Tempo ramp at <b>{{ Math.round(status.ramp.tempo * 100) }}%</b>. Reach
            {{ Math.round(opts.ramp.threshold * 100) }}% to move up.
          </p>
          <div class="actions">
            <button class="primary big-btn" @click="primaryPassAction">
              {{
                worstRange
                  ? `Loop bars ${worstRange.startMeasure + 1}–${worstRange.endMeasure + 1}`
                  : 'Play again'
              }}
              <kbd>Enter</kbd>
            </button>
            <button v-if="drillPlan.length > 1" class="big-btn" @click="startDrill()">
              Drill {{ drillPlan.length }} weak spots
            </button>
            <button v-if="worstRange" class="big-btn" @click="restart">
              Play again <kbd>R</kbd>
            </button>
            <button class="ghost big-btn" @click="lastPass = null">Close <kbd>Esc</kbd></button>
          </div>
        </div>

        <div class="details">
          <section aria-label="By bar">
            <div class="head">
              <h2>By bar</h2>
              <span class="muted">line = {{ Math.round(opts.ramp.threshold * 100) }}% clean</span>
            </div>
            <ul class="bars" role="list">
              <li v-for="m in lastPass.perMeasure" :key="m.measure" role="listitem">
                <button
                  :class="{ weak: m.accuracy !== null && m.accuracy < opts.ramp.threshold }"
                  :title="`Loop bar ${m.measure + 1} (shift-click to extend)`"
                  @click="selectMeasure(m.measure, $event.shiftKey)"
                >
                  <span class="label num">Bar {{ m.measure + 1 }}</span>
                  <span class="meter">
                    <i :style="{ width: `${(m.accuracy ?? 0) * 100}%` }" />
                    <i class="line" :style="{ left: `${opts.ramp.threshold * 100}%` }" />
                  </span>
                  <span class="note muted"
                    >{{ m.wrong ? `${m.wrong} wrong` : '' }}{{ m.wrong && m.miss ? ' · ' : ''
                    }}{{ m.miss ? `${m.miss} missed` : '' }}</span
                  >
                  <span class="pct num">{{ formatPercent(m.accuracy) }}</span>
                </button>
              </li>
            </ul>
          </section>

          <section aria-label="Timing">
            <div class="head">
              <h2>Timing</h2>
              <span class="muted"
                ><b>{{ meanLabel(passMean) }}</b> {{ presetLabel }}</span
              >
            </div>
            <div class="hist" aria-hidden="true">
              <i
                v-for="(b, i) in histogram"
                :key="i"
                :class="{ inside: b.inside }"
                :style="{ height: b.height }"
              />
            </div>
            <div class="hist-axis num muted">
              <span>−60 ms early</span><span>on time</span><span>late +60 ms</span>
            </div>
            <p class="muted">
              {{ insideWindow }} of {{ lastPass.deviations.length }} hits inside the window
            </p>
          </section>
        </div>

        <section v-if="lastTake" class="your-take" aria-labelledby="take-title">
          <div class="take-head">
            <div>
              <h2 id="take-title">Your take</h2>
              <p class="muted">
                Recorded automatically · {{ takeLabel(lastTake) }} · notes, timing, velocity, pedal
              </p>
            </div>
            <span class="spacer" />
            <button class="big-btn" @click="startReplay(lastTake)">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M7 4.5v15l12-7.5z" />
              </svg>
              Play my take <kbd>P</kbd>
            </button>
            <button
              class="big-btn"
              :aria-pressed="!!lastTake.starred"
              :title="lastTake.starred ? 'Starred: kept forever' : 'Star to keep forever'"
              @click="toggleStar(lastTake)"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                :fill="lastTake.starred ? 'currentColor' : 'none'"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
                />
              </svg>
              {{ lastTake.starred ? 'Starred' : 'Star' }} <kbd>S</kbd>
            </button>
            <button class="big-btn" @click="startReplay(lastTake, 'both')">
              Watch it against the score <kbd>V</kbd>
            </button>
            <button class="ghost big-btn" @click="openTakes">
              All takes · {{ takes.length }} <kbd>T</kbd>
            </button>
          </div>
          <TakeRoll
            :played="lastTakeNotes"
            :score="song?.notes ?? []"
            :from="lastTake.fromSec"
            :to="lastTake.toSec"
            :height="88"
          />
          <p class="muted hint">
            Outlines are the score, filled bars what you played. <kbd>Tab</kbd> plays the score
            instead, from the same spot.
          </p>
        </section>
      </section>
    </div>

    <footer v-if="replay" class="bar replay-bar">
      <button class="ghost big-btn" title="Back to practising (Esc)" @click="exitReplay">
        Practice <kbd>Esc</kbd>
      </button>

      <button
        class="play-btn"
        :aria-label="playing ? 'Pause' : 'Play'"
        :title="playing ? 'Pause (Space)' : 'Play (Space)'"
        @click="session?.toggle()"
      >
        <svg
          v-if="playing"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
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

      <div class="title">
        <span
          >Your take ·
          {{ replay.take.accuracy === null ? '–' : formatPercent(replay.take.accuracy) }} ·
          {{ Math.round(replay.take.tempo * 100) }}% tempo</span
        >
        <span class="muted"
          >{{ piece?.title }} · {{ takeLabel(replay.take) }} ·
          {{ takeTimeFmt.format(replay.take.startedAt) }}</span
        >
      </div>
      <span class="spacer" />
      <span v-if="replayElapsed" class="num pos">
        <b>{{ replayElapsed.at }}</b> <span class="muted">/ {{ replayElapsed.total }}</span>
      </span>
      <div class="segmented speed" role="group" aria-label="Speed">
        <button
          v-for="s in REPLAY_SPEEDS"
          :key="s"
          :class="{ active: replay.speed === s }"
          @click="setReplay({ speed: s })"
        >
          {{ s }}×
        </button>
      </div>
      <button
        class="options-btn"
        :aria-pressed="!!replay.take.starred"
        title="Star (S)"
        @click="toggleStar(replay.take)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          :fill="replay.take.starred ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
        </svg>
        {{ replay.take.starred ? 'Starred' : 'Star' }}
      </button>
      <button class="options-btn" title="Takes (T)" @click="openTakes">Takes</button>
    </footer>

    <footer v-else class="bar">
      <BackToLibrary />

      <div class="modes" role="radiogroup" aria-label="Mode">
        <button role="radio" :aria-checked="!listening" @click="mode = 'practice'">Practice</button>
        <button
          role="radio"
          :aria-checked="listening"
          data-testid="listen"
          @click="mode = 'listen'"
        >
          Listen
        </button>
      </div>

      <button
        class="play-btn"
        :disabled="!session || !canPlay"
        :aria-label="playing ? 'Pause' : 'Play'"
        :title="playing ? 'Pause (Space)' : 'Play (Space)'"
        data-testid="play"
        @click="session?.toggle()"
      >
        <svg
          v-if="playing"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
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
      <button
        class="ghost icon"
        aria-label="Restart"
        title="Restart (R)"
        :disabled="!session"
        @click="restart"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </svg>
      </button>

      <div class="title">
        <span>{{ piece?.title ?? 'Loading…' }}</span>
        <span class="muted">
          <template v-if="drill && drillStep"
            >Drill {{ drill.index + 1 }} of {{ drill.steps.length }} · bars
            {{ drillStep.startMeasure + 1 }}–{{ drillStep.endMeasure + 1 }}</template
          >
          <template v-else-if="opts.loopOn"
            >Loop bars {{ loopRange.startMeasure + 1 }}–{{ loopRange.endMeasure + 1 }}</template
          >
          <template v-else-if="lastTime?.accuracy != null"
            >Last time {{ formatPercent(lastTime.accuracy) }} at
            {{ Math.round(lastTime.tempo * 100) }}%</template
          >
          <template v-else>{{ measureCount }} bars</template>
        </span>
      </div>
      <span class="spacer" />
      <div class="pos num">
        <span class="muted">Bar</span> <b>{{ currentMeasure }}</b>
        <span class="muted">/ {{ measureCount }}</span>
      </div>
      <div class="tempo" role="group" aria-label="Tempo" :class="{ locked: activeRamp().enabled }">
        <button
          class="ghost"
          aria-label="Slower"
          title="Slower 5% ([)"
          :disabled="activeRamp().enabled"
          @click="changeTempo(-5)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M5 12h14" />
          </svg>
        </button>
        <span
          class="num value"
          role="status"
          aria-label="Tempo"
          :title="activeRamp().enabled ? 'Set by the tempo ramp' : undefined"
          ><b>{{ shownTempoPct }}%</b>
          <span v-if="song" class="muted"
            >{{ Math.round((baseBpm * shownTempoPct) / 100) }} bpm</span
          ></span
        >
        <button
          class="ghost"
          aria-label="Faster"
          title="Faster 5% (])"
          :disabled="activeRamp().enabled"
          @click="changeTempo(5)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M5 12h14M12 5v14" />
          </svg>
        </button>
      </div>

      <div
        v-if="status?.ramp"
        class="ramp-dots"
        role="img"
        :aria-label="`Tempo ramp: ${status.ramp.cleanStreak} of ${opts.ramp.cleanPasses} clean passes`"
      >
        <i
          v-for="i in opts.ramp.cleanPasses"
          :key="i"
          :class="{ on: i <= status.ramp.cleanStreak }"
        />
        <span class="muted"
          >→
          {{
            Math.round(Math.min(opts.ramp.target, status.ramp.tempo + opts.ramp.step) * 100)
          }}%</span
        >
      </div>

      <button
        class="options-btn"
        :class="{ active: settings.showStaff }"
        :aria-pressed="settings.showStaff"
        title="Sheet music (N)"
        @click="toggleStaff"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M3 10h18M3 14h18M3 18h18" opacity="0.45" />
          <path d="M15 17V5" />
          <ellipse cx="12.6" cy="17.2" rx="2.6" ry="1.9" fill="currentColor" stroke="none" />
        </svg>
        Notes
      </button>

      <button
        class="options-btn"
        :class="{ active: showPanel }"
        :aria-pressed="showPanel"
        title="Options (O)"
        @click="showPanel = !showPanel"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
          <circle cx="16" cy="6" r="2" />
          <circle cx="10" cy="12" r="2" />
          <circle cx="18" cy="18" r="2" />
        </svg>
        Options
      </button>
    </footer>

    <aside v-if="showPanel" class="sheet" aria-label="Options">
      <div class="sheet-head">
        <div class="tabs" role="tablist" aria-label="Panel">
          <button role="tab" :aria-selected="sheetTab === 'options'" @click="sheetTab = 'options'">
            Options
          </button>
          <button role="tab" :aria-selected="sheetTab === 'takes'" @click="sheetTab = 'takes'">
            Takes · {{ takes.length }}
          </button>
        </div>
        <button
          class="ghost icon"
          aria-label="Close options"
          title="Close (O)"
          @click="showPanel = false"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <template v-if="sheetTab === 'takes'">
        <section class="takes">
          <div v-if="opts.loopOn" class="segmented" role="group" aria-label="Show takes for">
            <button :class="{ active: takeFilter === 'loop' }" @click="takeFilter = 'loop'">
              This loop · {{ loopTakeCount }}
            </button>
            <button :class="{ active: takeFilter === 'piece' }" @click="takeFilter = 'piece'">
              Whole piece · {{ takes.length }}
            </button>
          </div>

          <p v-if="!takes.length" class="muted hint">
            Finish a pass and it appears here, ready to listen back to.
          </p>

          <template v-for="group in ['starred', 'recent'] as const" :key="group">
            <template v-if="shownTakes[group].length">
              <h3>{{ group === 'starred' ? 'Starred · kept forever' : 'Recent' }}</h3>
              <ul class="take-list">
                <li
                  v-for="t in shownTakes[group]"
                  :key="t.id"
                  :class="{ open: openTakeId === t.id, latest: t.id === takes[0]?.id }"
                >
                  <div class="take-row">
                    <button
                      class="ghost icon"
                      :aria-label="`Play take from ${takeTimeFmt.format(t.startedAt)}`"
                      @click="startReplay(t)"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M7 4.5v15l12-7.5z" />
                      </svg>
                    </button>
                    <button
                      class="ghost take-info"
                      :aria-expanded="openTakeId === t.id"
                      @click="openTakeId = openTakeId === t.id ? undefined : t.id"
                    >
                      <span
                        >{{ takeTimeFmt.format(t.startedAt)
                        }}<template v-if="t.id === takes[0]?.id"> · latest</template></span
                      >
                      <small class="muted">{{ takeLabel(t) }}</small>
                    </button>
                    <b class="num">{{ formatPercent(t.accuracy) }}</b>
                    <button
                      class="ghost icon"
                      :aria-pressed="!!t.starred"
                      :aria-label="t.starred ? 'Remove star' : 'Star this take'"
                      @click="toggleStar(t)"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        :fill="t.starred ? 'currentColor' : 'none'"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path
                          d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
                        />
                      </svg>
                    </button>
                  </div>
                  <div v-if="openTakeId === t.id" class="take-more">
                    <TakeRoll
                      :played="notesOf(t.events).notes"
                      :score="song?.notes ?? []"
                      :from="t.fromSec"
                      :to="t.toSec"
                      :height="56"
                    />
                    <div class="row">
                      <button @click="startReplay(t, 'both')">Compare <kbd>V</kbd></button>
                      <button @click="exportTake(t)">Export .mid</button>
                      <span class="spacer" />
                      <button class="ghost danger" @click="deleteTake(t)">Delete</button>
                    </div>
                  </div>
                </li>
              </ul>
            </template>
          </template>

          <p class="muted hint">
            Each pass you finish is kept as a take. The last 10 per piece stay; older unstarred
            takes are cleaned up on their own. Star a take to keep it.
          </p>
        </section>
      </template>

      <template v-else-if="listening">
        <section>
          <h3>Hear</h3>
          <label v-for="h in HANDS" :key="h" class="switch-row">
            <span>{{ h === 'L' ? 'Left hand' : 'Right hand' }}</span>
            <input v-model="opts.hear[h]" type="checkbox" class="switch" />
          </label>
          <label class="switch-row">
            <span>Metronome</span>
            <input v-model="opts.metronome" type="checkbox" class="switch" />
          </label>
          <label class="switch-row">
            <span>Repeat bars {{ loopRange.startMeasure + 1 }}–{{ loopRange.endMeasure + 1 }}</span>
            <input v-model="opts.loopOn" type="checkbox" class="switch" />
          </label>
        </section>

        <section class="your-turn">
          <h3>Your turn</h3>
          <p class="muted hint">
            Practice from bar {{ currentMeasure }} at this tempo, after a one-bar count-in.
          </p>
          <button class="primary" @click="practiceFromHere">Practice from here</button>
        </section>
      </template>

      <template v-else>
        <section>
          <h3>Hands</h3>
          <HandModeControl v-model="opts.hands.L" hand="L" />
          <HandModeControl v-model="opts.hands.R" hand="R" />
          <div class="row">
            <button
              :class="{ active: fixingHands }"
              :aria-pressed="fixingHands"
              @click="toggleFixHands"
            >
              {{ fixingHands ? 'Done fixing' : 'Fix hands' }}
            </button>
            <NuxtLink :to="`/piece/${hash}`" class="btn ghost">Split settings</NuxtLink>
          </div>
        </section>

        <section>
          <h3>Playing</h3>
          <label class="switch-row">
            <span class="label"
              >Focus while playing<small class="muted"
                >Hide controls and stats during play (F)</small
              ></span
            >
            <input v-model="settings.focusWhilePlaying" type="checkbox" class="switch" />
          </label>
          <label class="switch-row">
            <span class="label"
              >Wait mode<small class="muted"
                >Hold the music until you play the right notes</small
              ></span
            >
            <input v-model="opts.wait" type="checkbox" class="switch" />
          </label>
          <template v-if="opts.wait">
            <div class="seg-row">
              <span>Wait for</span>
              <div class="segmented">
                <button
                  v-for="h in WAIT_HANDS"
                  :key="h"
                  :class="{ active: opts.waitHands === h }"
                  :title="
                    h === 'both'
                      ? 'Hold for every note'
                      : `Hold for the ${h === 'L' ? 'left' : 'right'} hand, the other hand plays itself`
                  "
                  @click="opts.waitHands = h"
                >
                  {{ h === 'both' ? 'Both' : h === 'L' ? 'Left' : 'Right' }}
                </button>
              </div>
            </div>
            <div class="seg-row">
              <span>Chords</span>
              <div class="segmented">
                <button
                  :class="{ active: opts.waitChord === 'all' }"
                  @click="opts.waitChord = 'all'"
                >
                  Whole chord
                </button>
                <button
                  :class="{ active: opts.waitChord === 'any' }"
                  @click="opts.waitChord = 'any'"
                >
                  Any note
                </button>
              </div>
            </div>
            <p v-if="opts.waitHands !== 'both'" class="muted hint">
              The {{ opts.waitHands === 'L' ? 'right' : 'left' }} hand plays along by itself and
              pauses with you.
            </p>
            <label class="switch-row">
              <span>Held wrong notes block</span>
              <input v-model="opts.wrongBlocks" type="checkbox" class="switch" />
            </label>
          </template>
          <label class="switch-row">
            <span>Metronome</span>
            <input v-model="opts.metronome" type="checkbox" class="switch" />
          </label>
          <div class="seg-row">
            <span>Count-in</span>
            <div class="segmented">
              <button
                v-for="n in COUNT_INS"
                :key="n"
                :class="{ active: opts.countIn === n }"
                @click="opts.countIn = n"
              >
                {{ n === 0 ? 'Off' : `${n} bar${n > 1 ? 's' : ''}` }}
              </button>
            </div>
          </div>
          <div class="seg-row">
            <span>Look-ahead</span>
            <div class="segmented">
              <button
                v-for="s in LOOK_AHEADS"
                :key="s"
                :class="{ active: settings.lookahead === s }"
                @click="settings.lookahead = s"
              >
                {{ s }} s
              </button>
            </div>
          </div>
          <div class="seg-row">
            <span>Timing</span>
            <div class="segmented">
              <button
                :class="{ active: settings.timingWindowMs === 35 }"
                @click="settings.timingWindowMs = 35"
              >
                Strict ±35
              </button>
              <button
                :class="{ active: settings.timingWindowMs === 60 }"
                @click="settings.timingWindowMs = 60"
              >
                Relaxed ±60
              </button>
            </div>
          </div>
        </section>

        <section>
          <h3>Loop &amp; sections</h3>
          <label class="switch-row">
            <span>Loop bars</span>
            <input v-model="opts.loopOn" type="checkbox" class="switch" />
          </label>
          <div class="row">
            <input
              :value="opts.loopFrom"
              type="number"
              min="1"
              :max="measureCount"
              aria-label="Loop from bar"
              @change="commitLoopField('loopFrom', $event)"
            />
            <span class="muted">to</span>
            <input
              :value="opts.loopTo"
              type="number"
              min="1"
              :max="measureCount"
              aria-label="Loop to bar"
              @change="commitLoopField('loopTo', $event)"
            />
          </div>
          <div v-if="sections.length" class="sections">
            <button
              v-for="s in sections"
              :key="s.id"
              :class="{ active: s.id === activeSectionId }"
              :aria-pressed="s.id === activeSectionId"
              @click="setLoop(s.startMeasure, s.endMeasure)"
            >
              {{ s.label }} · {{ s.startMeasure + 1 }}–{{ s.endMeasure + 1 }}
            </button>
          </div>
          <div class="row">
            <input v-model="sectionLabel" placeholder="Section name" aria-label="Section name" />
            <button @click="saveSection">Save current</button>
          </div>
          <div v-if="sections.length" class="row wrap-del">
            <button
              v-for="s in sections"
              :key="s.id"
              class="ghost small"
              :aria-label="`Delete section ${s.label}`"
              @click="deleteSection(s.id)"
            >
              ✕ {{ s.label }}
            </button>
          </div>
        </section>

        <section>
          <label class="switch-row">
            <span class="label"
              >Tempo ramp<small class="muted">{{
                opts.loopOn
                  ? `Bars ${loopRange.startMeasure + 1}–${loopRange.endMeasure + 1}: ${Math.round((rampFrom() ?? opts.ramp.start) * 100)}%`
                  : 'Steps the tempo up while looping'
              }}</small></span
            >
            <input v-model="opts.ramp.enabled" type="checkbox" class="switch" />
          </label>
          <div v-if="opts.ramp.enabled" class="grid">
            <label class="field"
              ><span>Start %</span
              ><input v-model.number="rampStart" type="number" min="25" max="150" step="5"
            /></label>
            <label class="field"
              ><span>Step %</span><input v-model.number="rampStep" type="number" min="1" max="50"
            /></label>
            <label class="field"
              ><span>Target %</span
              ><input v-model.number="rampTarget" type="number" min="25" max="150" step="5"
            /></label>
            <label class="field"
              ><span>Clean passes</span
              ><input v-model.number="opts.ramp.cleanPasses" type="number" min="1" max="10"
            /></label>
            <label class="field"
              ><span>Clean at %</span
              ><input v-model.number="rampThreshold" type="number" min="50" max="100"
            /></label>
            <label class="field"
              ><span>Slow down after</span
              ><input v-model.number="opts.ramp.failPasses" type="number" min="0" max="10"
            /></label>
            <button v-if="rampFrom() !== null" class="ghost" @click="restartRamp">
              Restart ramp
            </button>
          </div>
        </section>

        <section v-if="passHistory.length">
          <h3>Recent passes</h3>
          <div class="history">
            <span
              v-for="(acc, i) in passHistory"
              :key="i"
              :style="{ height: `${Math.max(4, acc * 100)}%` }"
              :class="{ weak: acc < opts.ramp.threshold }"
              :title="formatPercent(acc)"
            />
          </div>
        </section>
      </template>

      <section class="status">
        <h3>Status</h3>
        <div class="row">
          <button
            v-if="midi.supported && !midi.connected && midi.permission !== 'denied'"
            class="status-pill off"
            @click="midi.connect()"
          >
            <i />Connect MIDI
          </button>
          <NuxtLink v-else to="/settings" class="status-pill" :class="{ off: !midi.devices.length }"
            ><i />{{ midiLabel }}</NuxtLink
          >
          <span class="status-pill" :class="{ warn: audio.error || audio.state !== 'running' }"
            ><i />{{
              audio.error ? 'Piano failed' : audio.state === 'running' ? 'Sound on' : 'Sound paused'
            }}</span
          >
        </div>
        <p class="muted hint">
          Space play · R restart · ←/→ bar · [ ] tempo · L loop bar · Esc clear loop · F focus · O
          options<br />While the computer keyboard plays notes (Z–/, Q–], left Shift = pedal), hold
          Alt for R, L, O, [ and ].
        </p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.practice {
  height: 100dvh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    'head sheet'
    'staff sheet'
    'stage sheet'
    'bar bar';
  overflow: hidden;
  background: var(--bg);
}

.stage {
  grid-area: stage;
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

canvas.staff {
  grid-area: staff;
  position: static;
  display: block;
  height: clamp(130px, 24dvh, 200px);
  border-bottom: 1px solid var(--line);
}

canvas.fixing {
  cursor: pointer;
}

/* Header: a thin progress line while playing in focus mode, otherwise ruler, stats and quick settings. */
.head {
  grid-area: head;
  position: relative;
  z-index: 2;
  background: var(--bg);
}

.head.ruler {
  padding: 8px 20px 14px;
  border-bottom: 1px solid var(--line);
}

.head-row {
  display: flex;
  align-items: flex-end;
  gap: 24px;
  margin-top: 14px;
}

.side {
  display: grid;
  justify-items: end;
  gap: 10px;
}

.loop-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  font-size: 15px;
  color: var(--muted);
}

.loop-row b {
  color: var(--hi);
  font-weight: 500;
}

.legend {
  display: flex;
  align-items: center;
  gap: 6px;
}

.legend i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
}

/* Heads-up stats, top left. Sizes chosen for reading from the music stand. */
.hud {
  display: grid;
  gap: 8px;
}

.hud.float {
  position: absolute;
  left: 40px;
  top: 24px;
  z-index: 1;
  pointer-events: none;
  text-shadow: 0 0 12px var(--bg);
}

.big {
  display: flex;
  align-items: baseline;
  gap: 4px;
  color: var(--muted);
}

.big b {
  font-size: 72px;
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--hi);
}

.head .big b {
  font-size: 56px;
}

.big span {
  font-size: 28px;
  font-weight: 300;
}

.big small {
  font-size: 18px;
  margin-left: 10px;
}

.counts {
  display: flex;
  gap: 24px;
  font-size: 18px;
  color: var(--muted);
}

.counts span {
  display: flex;
  align-items: center;
  gap: 8px;
}

.counts b {
  font-size: 28px;
  font-weight: 400;
  color: var(--hi);
}

i.x {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--danger);
  position: relative;
}

i.x::before,
i.x::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  top: 8px;
  height: 2.5px;
  border-radius: 2px;
  background: var(--bg);
  rotate: 45deg;
}

i.x::after {
  rotate: -45deg;
}

i.ring {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2.5px solid var(--miss);
}

.timing-line {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  color: var(--muted);
}

.timing-line b {
  font-weight: 400;
  color: var(--text);
}

.meter {
  position: relative;
  width: 72px;
  height: 14px;
}

.meter::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 6px;
  height: 2px;
  background: var(--border);
}

.meter .band {
  position: absolute;
  top: 3px;
  height: 8px;
  left: 50%;
  translate: -50% 0;
  border-radius: 2px;
  background: var(--surface-2);
}

.meter .zero {
  position: absolute;
  left: 50%;
  top: 1px;
  width: 1px;
  height: 12px;
  background: var(--faint);
}

.meter .knob {
  position: absolute;
  top: 0;
  width: 4px;
  height: 14px;
  margin-left: -2px;
  border-radius: 2px;
  background: var(--hi);
  transition: left 0.12s;
}

/* Compact options strip, top right, when focus is off. */
.strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.strip button {
  height: 44px;
  padding: 0 14px;
  border-radius: 12px;
  font-size: 18px;
  background: var(--bg);
  color: var(--muted);
}

.strip button[aria-pressed='true'] {
  background: var(--surface-2);
  border-color: var(--text);
  color: var(--hi);
}

.device {
  display: flex;
  gap: 8px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 99px;
  background: transparent;
  color: var(--muted);
  font-size: 15px;
  text-decoration: none;
  white-space: nowrap;
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

.status-pill.warn {
  border-color: var(--danger);
  color: var(--text);
}

.status-pill.warn i {
  background: var(--danger);
}

.overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 12px;
  background: rgb(var(--ink) / 0.04);
  backdrop-filter: blur(2px);
  font-size: 18px;
}

.chip {
  position: absolute;
  /* Top of the lane: far-ahead notes, never the ones about to be played. */
  top: 20px;
  left: 50%;
  translate: -50% 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-radius: 99px;
  background: var(--inv);
  color: var(--inv-text);
  font-size: 18px;
  font-weight: 500;
  white-space: nowrap;
}

.chip.soft {
  background: var(--surface);
  color: var(--muted);
  border: 1px solid var(--border);
  font-weight: 400;
}

.chip .ghost {
  color: inherit;
}

.chip kbd,
kbd {
  font-family: var(--mono);
  font-size: 0.8em;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid currentColor;
  opacity: 0.8;
}

.target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.target i {
  width: 12px;
  height: 12px;
  border-radius: 6px;
  background: var(--right);
}

.target i.L {
  border-radius: 2px;
  background: var(--left);
}

.toast {
  position: absolute;
  top: 76px;
  left: 50%;
  translate: -50% 0;
  z-index: 2;
  pointer-events: none;
}

.toast span {
  display: block;
  padding: 8px 16px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-size: 16px;
  white-space: nowrap;
}

/* Pass complete: verdict first, then bars, then timing. */
.complete {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  align-content: start;
  gap: 28px 48px;
  padding: 32px 56px;
  background: var(--bg);
  overflow: auto;
}

.verdict {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.eyebrow {
  font-size: 18px;
  color: var(--muted);
}

.score b {
  font-size: clamp(96px, 13vw, 168px);
  font-weight: 200;
  letter-spacing: -0.05em;
}

.score span {
  font-size: 48px;
}

.verdict p {
  margin: 0;
  font-size: 18px;
}

.verdict p b {
  color: var(--hi);
  font-weight: 500;
}

.ramp-note {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
}

.dots,
.ramp-dots {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dots i,
.ramp-dots i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--faint);
}

.dots i.on,
.ramp-dots i.on {
  background: var(--text);
  border-color: var(--text);
}

.ramp-dots span {
  margin-left: 4px;
  font-size: 18px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}

.big-btn {
  height: 52px;
  padding: 0 20px;
  font-size: 18px;
  border-radius: 12px;
}

.details {
  display: grid;
  align-content: start;
  gap: 36px;
}

.details .head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.details h2 {
  font-size: 20px;
  font-weight: 500;
}

.details .head span {
  font-size: 15px;
}

.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  max-height: 46vh;
  overflow: auto;
}

.bars button {
  width: 100%;
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr) 150px 64px;
  align-items: center;
  gap: 16px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  font-size: 18px;
  text-align: left;
}

.bars button:hover:not(:disabled) {
  background: var(--surface);
}

.bars .label {
  color: var(--muted);
}

.bars .meter {
  width: auto;
  height: 12px;
}

.bars .meter::before {
  top: 0;
  height: 12px;
  border-radius: 3px;
  background: var(--surface-2);
}

.bars .meter i:first-child {
  position: absolute;
  left: 0;
  top: 0;
  height: 12px;
  border-radius: 3px;
  background: var(--text);
}

.bars .weak .meter i:first-child {
  background: repeating-linear-gradient(135deg, var(--danger) 0 6px, rgb(var(--ink) / 0) 6px 9px);
}

.bars .meter .line {
  position: absolute;
  top: -4px;
  width: 2px;
  height: 20px;
  background: var(--faint);
}

.bars .note {
  font-size: 15px;
}

.bars .pct {
  text-align: right;
  color: var(--hi);
}

.bars .weak .pct {
  color: var(--danger);
}

.hist {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
}

.hist i {
  flex: 1;
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: var(--surface-2);
}

.hist i.inside {
  background: var(--text);
}

.hist-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 15px;
}

/* Your take on the pass summary. */
.your-take {
  grid-column: 1 / -1;
  display: grid;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}

.take-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.take-head h2 {
  font-size: 20px;
  font-weight: 500;
}

.take-head p {
  margin: 4px 0 0;
  font-size: 15px;
}

/* Replay. */
.replay-legend {
  display: flex;
  gap: 18px;
  font-size: 15px;
  color: var(--muted);
}

.replay-legend span {
  display: flex;
  align-items: center;
  gap: 8px;
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
}

.swatch.outline {
  border: 2px solid var(--right);
}

.swatch.filled {
  background: var(--right);
}

.swatch.pedal {
  height: 6px;
  background: var(--rim);
  opacity: 0.55;
}

.replay-modes {
  margin: 0;
}

.compare-with {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
}

.replay-bar .speed button {
  min-width: 52px;
  font-size: 16px;
}

/* Panel tabs and the takes list. */
.tabs {
  display: flex;
  gap: 4px;
}

.tabs button {
  border: 0;
  background: transparent;
  font-size: 20px;
  font-weight: 500;
  color: var(--muted);
  padding: 4px 8px;
}

.tabs button[aria-selected='true'] {
  color: var(--hi);
}

.takes {
  border-top: 0 !important;
  padding-top: 0 !important;
}

.take-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.take-list li {
  border-radius: 10px;
}

.take-list li.open {
  background: var(--surface-2);
}

.take-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.take-row .icon {
  width: 40px;
  height: 40px;
}

.take-info {
  flex: 1;
  display: grid;
  justify-items: start;
  gap: 2px;
  padding: 6px 8px;
  border: 0;
  text-align: left;
}

.take-row b {
  font-size: 22px;
  font-weight: 400;
  color: var(--hi);
}

.take-more {
  display: grid;
  gap: 10px;
  padding: 4px 10px 12px;
}

button.danger {
  color: var(--danger);
}

/* Bottom bar: everything for the next action, dimmed while playing in focus mode. */
.bar {
  grid-area: bar;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 84px;
  padding: 0 20px;
  border-top: 1px solid var(--line);
  font-size: 18px;
  color: var(--muted);
  background: var(--bg);
  transition: opacity 0.3s;
  z-index: 3;
  white-space: nowrap;
}

.quiet .bar {
  opacity: 0.35;
}

.quiet .bar:hover,
.quiet .bar:focus-within {
  opacity: 1;
}

.icon {
  width: 48px;
  height: 48px;
  padding: 0;
  justify-content: center;
  border-radius: 24px;
}

.modes {
  display: flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.modes button {
  height: 46px;
  padding: 0 18px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
}

.modes button[aria-checked='true'] {
  background: var(--surface-2);
  color: var(--hi);
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

.title {
  display: grid;
  line-height: 1.25;
  min-width: 0;
}

.title > span:first-child {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 26ch;
}

.pos b,
.tempo b {
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
}

.tempo .value {
  min-width: 150px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
}

.options-btn {
  height: 52px;
  padding: 0 16px;
  gap: 10px;
  border-radius: 12px;
  font-size: 18px;
  background: transparent;
}

/* Options sit beside the lane, which narrows so every key stays visible. */
.sheet {
  grid-area: sheet;
  width: min(400px, 40vw);
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 28px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: grid;
  align-content: start;
  gap: 22px;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet h2 {
  font-size: 22px;
  font-weight: 500;
}

.sheet section {
  display: grid;
  gap: 10px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.sheet h3 {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.seg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 500;
}

.sheet input[type='number'] {
  width: 76px;
}

.sections {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wrap-del {
  gap: 4px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.history {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 48px;
}

.history span {
  flex: 1;
  border-radius: 2px;
  background: var(--text);
}

.history span.weak {
  background: var(--danger);
}

.hint {
  font-size: 0.82rem;
  margin: 0;
  line-height: 1.5;
}

@media (max-width: 1100px) {
  .title,
  .ramp-dots {
    display: none;
  }
  .complete {
    grid-template-columns: 1fr;
    padding: 28px;
  }
}

@media (max-width: 760px) {
  .bar {
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
  }
  .pos,
  .options-btn span {
    display: none;
  }
  .hud.float {
    left: 16px;
  }
  .head-row .side {
    display: none;
  }
  .big b {
    font-size: 48px;
  }
  .practice {
    grid-template-areas:
      'head head'
      'staff staff'
      'stage stage'
      'bar bar';
  }
  .sheet {
    grid-area: stage;
    width: 100%;
    z-index: 5;
  }
}
</style>
