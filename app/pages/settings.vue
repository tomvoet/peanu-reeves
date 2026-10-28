<script setup lang="ts">
import type { AppSettings, Backup } from '#db/repositories'
import { TONES } from '#engine/audio/tones'
import { REMOTE_ACTIONS, type RemoteAction, type RemoteBinding } from '#engine/midi-input/remote'

interface Option<T> {
  value: T
  label: string
}

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const satisfies readonly Option<AppSettings['theme']>[]

const NOTE_LABEL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'c', label: 'C only' },
  { value: 'all', label: 'All' },
] as const satisfies readonly Option<AppSettings['noteLabels']>[]

const TIMING_PRESETS = [
  { value: 35, label: 'Strict ±35 ms' },
  { value: 60, label: 'Relaxed ±60 ms' },
] as const satisfies readonly Option<AppSettings['timingWindowMs']>[]

const REMOTE_LABELS = {
  toggle: 'Play / pause',
  restart: 'Restart loop or piece',
  prevBar: 'Previous bar',
  nextBar: 'Next bar',
  slower: 'Tempo −5%',
  faster: 'Tempo +5%',
} as const satisfies Record<RemoteAction, string>

const PEDALS: Partial<Record<number, string>> = {
  64: 'Sustain pedal',
  66: 'Sostenuto pedal',
  67: 'Soft pedal',
}

const settings = useSettings()
const runtime = useRuntime()
const midi = useMidiStatus()
const audio = useAudioStatus()
const repos = useRepos()
const library = useLibrary()
const backups = useBackup()
const sync = useSync()
const confirmStopSync = refAutoReset(false, 4000)

const latency = ref(runtime.latency)
const lastNote = ref<string | null>(null)
const learning = ref<RemoteAction | null>(null)
const dataStatus = ref<string | null>(null)
const pendingRestore = shallowRef<Backup | null>(null)

useIntervalFn(() => (latency.value = runtime.latency), 1000)

const offNoteOn = runtime.input.onNoteOn(
  (pitch, velocity) => (lastNote.value = `${pitchName(pitch)} · velocity ${velocity}`),
)

const ms = (s: number | undefined) => (s === undefined ? '–' : `${(s * 1000).toFixed(1)} ms`)

function describeBinding(b: RemoteBinding | undefined) {
  if (!b) return 'Not set'
  return b.kind === 'note'
    ? `Key ${pitchName(b.number)}`
    : (PEDALS[b.number] ?? `Controller ${b.number}`)
}

async function learn(action: RemoteAction) {
  if (learning.value === action) {
    runtime.remote.cancelLearning()
    learning.value = null
    return
  }

  learning.value = action
  const binding = await runtime.remote.learn()
  if (learning.value !== action) return
  learning.value = null

  const next = { ...settings.remote }
  for (const a of REMOTE_ACTIONS) {
    const b = next[a]
    if (b && b.kind === binding.kind && b.number === binding.number) delete next[a]
  }
  next[action] = binding
  applyBindings(next)
}

function applyBindings(next: AppSettings['remote']) {
  settings.remote = next
  runtime.remote.bindings = next
  void repos.settings.save({ remote: next })
}

function unbind(action: RemoteAction) {
  const next = { ...settings.remote }
  delete next[action]
  applyBindings(next)
}

function isBackup(value: unknown): value is Backup {
  return (
    typeof value === 'object' && value !== null && 'app' in value && value.app === 'peanu-reeves'
  )
}

async function exportBackup() {
  const backup = await backups.save()
  dataStatus.value = `Backup saved: ${backup.pieces.length} pieces, ${backup.attempts.length} passes.`
}

async function exportCsv() {
  const day = new Date().toISOString().slice(0, 10)
  downloadFile(`peanu-reeves-passes-${day}.csv`, 'text/csv', await repos.backup.attemptsCsv())
}

const { open: pickBackup, onChange: onBackupPicked } = useFileDialog({
  accept: '.json,application/json',
  multiple: false,
})
onBackupPicked(async (files) => {
  const file = files?.[0]
  if (!file) return

  try {
    const backup: unknown = JSON.parse(await file.text())
    if (!isBackup(backup)) throw new Error('Not a Peanu Reeves backup file.')
    pendingRestore.value = backup
    dataStatus.value = null
  } catch (e) {
    dataStatus.value = e instanceof Error ? e.message : String(e)
  }
})

async function confirmRestore() {
  const backup = pendingRestore.value
  if (!backup) return

  await repos.backup.restore(backup)
  for (const [key, value] of Object.entries(backup.local)) localStorage.setItem(key, value)
  Object.assign(settings, await repos.settings.load())
  await library.refresh()

  pendingRestore.value = null
  dataStatus.value = `Restored ${backup.pieces.length} pieces and ${backup.attempts.length} passes.`
  void sync.run()
}

onMounted(() => void backups.checkPersisted())

onBeforeUnmount(() => {
  offNoteOn()
  runtime.remote.cancelLearning()
})
</script>

<template>
  <main class="page">
    <h1>Settings</h1>

    <section class="card grid">
      <h2>Input</h2>
      <label class="field">
        <span>MIDI device</span>
        <select v-model="settings.midiDeviceId" :disabled="!midi.supported">
          <option value="all">All connected devices</option>
          <option v-for="d in midi.devices" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </label>
      <p v-if="!midi.supported" class="notice error">
        Web MIDI is not available in this browser. Use Chrome or Edge.
      </p>
      <div v-else-if="!midi.connected && midi.permission === 'denied'" class="notice grid">
        <b>Chrome did not allow MIDI for this site.</b>
        <span
          >This happens when the permission prompt was dismissed or blocked. Click the icon left of
          the address bar, open <b>Site settings</b>, set <b>MIDI device control</b> (sometimes
          called “Control &amp; reprogram MIDI devices”) to <b>Allow</b>, then try again. The same
          list is at <code>chrome://settings/content/midiDevices</code>.</span
        >
        <div class="row">
          <button class="primary" :disabled="midi.connecting" @click="midi.connect()">
            Try again
          </button>
          <span class="muted small">{{ midi.error }}</span>
        </div>
      </div>
      <div v-else-if="!midi.connected" class="notice row">
        <span>Chrome asks once before a site may use MIDI devices.</span>
        <span v-if="midi.error" class="muted small">{{ midi.error }}</span>
        <span class="spacer" />
        <button class="primary" :disabled="midi.connecting" @click="midi.connect()">
          Connect MIDI keyboard
        </button>
      </div>
      <p v-else-if="midi.error" class="notice error">MIDI access failed: {{ midi.error }}</p>
      <p v-else-if="!midi.devices.length" class="muted">
        No MIDI devices detected. Plug in your keyboard and it is picked up automatically.
      </p>
      <label class="switch-row">
        <span class="label"
          >Computer keyboard plays notes<small class="muted"
            >Z to / and Q to ] play two octaves. Left Shift is the pedal.</small
          ></span
        >
        <input v-model="settings.keyboardInput" type="checkbox" class="switch" />
      </label>
      <p class="muted">
        Last note: <span class="num">{{ lastNote ?? 'play something' }}</span>
      </p>
    </section>

    <section id="timing" class="card grid">
      <div class="row">
        <h2>Timing</h2>
        <span class="spacer" />
        <span class="muted num small"
          >output {{ ms(latency.output) }} · base {{ ms(latency.base) }} ·
          {{ (latency.sampleRate / 1000).toFixed(1) }} kHz</span
        >
      </div>
      <CalibrationCard />
      <label class="switch-row">
        <span class="label"
          >Hit window: ±{{ settings.toleranceMs }} ms<small class="muted"
            >How far off a note may be and still count. Widens at slower tempo.</small
          ></span
        >
        <input
          v-model.number="settings.toleranceMs"
          type="range"
          min="50"
          max="300"
          step="10"
          aria-label="Hit window"
          class="slider"
        />
      </label>
    </section>

    <section class="card grid">
      <h2>Display</h2>
      <div class="switch-row">
        <span class="label">Theme</span>
        <div class="segmented" role="group" aria-label="Theme">
          <button
            v-for="o in THEME_OPTIONS"
            :key="o.value"
            :class="{ active: settings.theme === o.value }"
            :aria-pressed="settings.theme === o.value"
            @click="settings.theme = o.value"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
      <label class="switch-row">
        <span class="label"
          >Focus while playing<small class="muted"
            >Hide controls and live stats while the music runs. F toggles it.</small
          ></span
        >
        <input v-model="settings.focusWhilePlaying" type="checkbox" class="switch" />
      </label>
      <div class="switch-row">
        <span class="label"
          >Timing feedback<small class="muted"
            >Window counted as on time in the timing meter and pass summary.</small
          ></span
        >
        <div class="segmented" role="group" aria-label="Timing feedback">
          <button
            v-for="o in TIMING_PRESETS"
            :key="o.value"
            :class="{ active: settings.timingWindowMs === o.value }"
            @click="settings.timingWindowMs = o.value"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
      <label class="field">
        <span>Look-ahead: {{ settings.lookahead.toFixed(1) }} s of music on screen</span>
        <input v-model.number="settings.lookahead" type="range" min="1" max="8" step="0.5" />
      </label>
      <div class="switch-row">
        <span class="label">Note names on keys</span>
        <div class="segmented" role="group" aria-label="Note names on keys">
          <button
            v-for="o in NOTE_LABEL_OPTIONS"
            :key="o.value"
            :class="{ active: settings.noteLabels === o.value }"
            :aria-pressed="settings.noteLabels === o.value"
            @click="settings.noteLabels = o.value"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
      <label class="switch-row">
        <span class="label"
          >Fit keyboard to the piece<small class="muted"
            >Show only the octaves a piece uses, so keys are wider.</small
          ></span
        >
        <input v-model="settings.fitKeyboard" type="checkbox" class="switch" />
      </label>
    </section>

    <section class="card grid">
      <h2>Audio</h2>
      <dl class="stats num">
        <dt>Base latency</dt>
        <dd>{{ ms(latency.base) }}</dd>
        <dt>Output latency</dt>
        <dd>{{ ms(latency.output) }}</dd>
        <dt>Total</dt>
        <dd>{{ ms((latency.base ?? 0) + (latency.output ?? 0)) }}</dd>
        <dt>Sample rate</dt>
        <dd>{{ latency.sampleRate }} Hz</dd>
        <dt>Context</dt>
        <dd>{{ audio.state }}</dd>
      </dl>
      <p class="muted">
        Above roughly 20–30 ms total the delay between key and sound becomes noticeable. Output
        latency is decided by the OS audio stack. A wired output device usually helps.
      </p>
      <label class="field">
        <span>Sound</span>
        <select v-model="settings.tone">
          <option v-for="(t, id) in TONES" :key="id" :value="id">{{ t.name }}</option>
        </select>
        <span class="muted small">{{ TONES[settings.tone].credit }}</span>
      </label>
      <label class="field">
        <span>Volume: {{ settings.volume }}</span>
        <input v-model.number="settings.volume" type="range" min="0" max="127" />
      </label>
      <label class="field">
        <span>Polyphony (voices before the oldest is cut)</span>
        <input v-model.number="settings.maxVoices" type="number" min="16" max="256" step="8" />
      </label>
    </section>

    <section class="card grid">
      <div>
        <h2>Control from the piano</h2>
        <p class="muted">
          Bind spare keys (for example the lowest A, A♯ and B) or a pedal to practice commands, so
          your hands stay on the keyboard. Bound keys stop making sound and are never scored. The
          sustain pedal is best left alone.
        </p>
      </div>
      <ul class="bindings">
        <li v-for="a in REMOTE_ACTIONS" :key="a">
          <span>{{ REMOTE_LABELS[a] }}</span>
          <span class="num muted" :class="{ set: settings.remote[a] }">{{
            learning === a ? 'Press a key or pedal…' : describeBinding(settings.remote[a])
          }}</span>
          <button :class="{ active: learning === a }" @click="learn(a)">
            {{ learning === a ? 'Cancel' : 'Learn' }}
          </button>
          <button
            class="ghost"
            :disabled="!settings.remote[a]"
            :aria-label="`Clear ${REMOTE_LABELS[a]}`"
            @click="unbind(a)"
          >
            Clear
          </button>
        </li>
      </ul>
    </section>

    <section id="sync" class="card grid">
      <h2>Sync between devices</h2>
      <p class="muted">
        Pick a folder that Dropbox, OneDrive, iCloud Drive or Syncthing keeps in sync, and the same
        folder on your other devices. Pieces, passes, takes, recordings, sections and hand fixes
        travel through it, MIDI files included. Nothing goes anywhere else. Set the folder to
        "always keep on this device" in your sync app.
      </p>
      <template v-if="sync.folder.value">
        <p class="muted" role="status">
          Folder <b>{{ sync.folder.value.name }}</b> ·
          <template v-if="sync.permission.value === 'prompt' || sync.permission.value === 'denied'"
            >needs access again</template
          >
          <template v-else-if="sync.running.value">syncing…</template>
          <template v-else
            >last synced <b>{{ formatAgo(sync.lastSyncAt.value ?? undefined) }}</b></template
          >
          <template v-if="sync.report.value">
            · {{ sync.report.value.devices }} other
            {{ sync.report.value.devices === 1 ? 'device' : 'devices' }}</template
          >
          <template v-if="sync.pending.value"> · {{ sync.pending.value }} changes to send</template>
        </p>
        <div class="row">
          <button
            v-if="sync.permission.value === 'prompt' || sync.permission.value === 'denied'"
            class="primary"
            @click="sync.resume()"
          >
            Resume sync
          </button>
          <button v-else :disabled="sync.running.value" @click="sync.run()">Sync now</button>
          <button
            class="ghost"
            :class="{ danger: confirmStopSync }"
            @click="confirmStopSync ? sync.stop() : (confirmStopSync = true)"
          >
            {{ confirmStopSync ? 'Click again to stop' : 'Stop syncing' }}
          </button>
        </div>
        <p v-if="sync.report.value?.problems.length" class="muted">
          Skipped: {{ sync.report.value.problems.join('; ') }}
        </p>
      </template>
      <div v-else class="row">
        <button class="primary" :disabled="!sync.supported" @click="sync.choose()">
          Choose sync folder…
        </button>
        <span v-if="!sync.supported" class="muted">This browser cannot open folders.</span>
      </div>
      <p v-if="sync.error.value" class="notice error" role="alert">{{ sync.error.value }}</p>
    </section>

    <section class="card grid">
      <h2>Your data</h2>
      <p class="muted">
        Everything lives in this browser. Save a backup now and then, otherwise clearing site data
        or switching computers loses it. Folder files stay in the folder and are not part of the
        backup.
      </p>
      <p class="muted">
        Last backup: <b>{{ formatAgo(settings.lastBackupAt ?? undefined) }}</b> ·
        <template v-if="backups.persisted.value">Storage is kept permanently</template>
        <template v-else-if="backups.persisted.value === false"
          >The browser may clear storage when space runs low
          <button class="ghost" @click="backups.keep()">Ask to keep it</button></template
        >
      </p>
      <div class="row">
        <button class="primary" @click="exportBackup">Save backup</button>
        <button @click="pickBackup()">Restore from backup…</button>
        <button class="ghost" @click="exportCsv">Export passes as CSV</button>
      </div>
      <div v-if="pendingRestore" class="notice row">
        <span
          >Replace all practice data with the backup from
          {{ new Date(pendingRestore.exportedAt).toLocaleString() }} ({{
            pendingRestore.pieces.length
          }}
          pieces, {{ pendingRestore.attempts.length }} passes)?<template v-if="sync.folder.value">
            Other devices keep their data and it comes back through sync.</template
          ></span
        >
        <span class="spacer" />
        <button class="ghost" @click="pendingRestore = null">Cancel</button>
        <button class="primary" @click="confirmRestore">Replace</button>
      </div>
      <p v-if="dataStatus" class="muted" role="status">{{ dataStatus }}</p>
    </section>
  </main>
</template>

<style scoped>
.page {
  max-width: 760px;
}

.grid {
  display: grid;
  gap: 14px;
}

h1 {
  font-size: 2rem;
  letter-spacing: -0.02em;
}

p {
  margin: 0;
}

.bindings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}

.bindings li {
  display: grid;
  grid-template-columns: 1fr 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}

.bindings .set {
  color: var(--text);
}

@media (max-width: 560px) {
  .bindings li {
    grid-template-columns: 1fr auto auto;
  }
  .bindings li > span:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}

.small {
  font-size: 0.75rem;
}

.slider {
  width: 200px;
}

.stats {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 24px;
  margin: 0;
}

dt {
  color: var(--muted);
}

dd {
  margin: 0;
}

.danger {
  color: var(--danger);
}
</style>
