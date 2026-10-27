import { createRepositories } from '#db/repositories'
import { Runtime } from '#engine/runtime'
import type { LoadProgress } from '#engine/audio/piano'
import { WebMidiInput } from '#engine/midi-input/web-midi'
import type { AudioStatus, MidiStatus } from '~/composables/useApp'

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export default defineNuxtPlugin(async () => {
  const repos = createRepositories()
  const settings = reactive(await repos.settings.load())

  const runtime = new Runtime({
    maxVoices: settings.maxVoices,
    volume: settings.volume,
    tone: settings.tone,
    samplesUrl: `${useRuntimeConfig().app.baseURL}samples`,
  })
  runtime.setKeyboardEnabled(settings.keyboardInput)
  runtime.remote.bindings = { ...settings.remote }

  const audio = reactive<AudioStatus>({
    loaded: 0,
    total: 0,
    ready: false,
    error: null,
    state: runtime.ctx.state,
  })

  useEventListener(runtime.ctx, 'statechange', () => (audio.state = runtime.ctx.state))
  const loadWithStatus = (load: (onProgress: (p: LoadProgress) => void) => Promise<void>) => {
    Object.assign(audio, { loaded: 0, total: 0, ready: false, error: null })
    const pending = load(({ loaded, total }) => Object.assign(audio, { loaded, total }))
    pending
      .then(() => runtime.piano.ready === pending && (audio.ready = true))
      .catch((e: unknown) => runtime.piano.ready === pending && (audio.error = errorMessage(e)))
  }
  loadWithStatus((p) => runtime.piano.load(p))
  watch(
    () => settings.tone,
    (tone) => loadWithStatus((p) => runtime.piano.setTone(tone, p)),
  )

  const resume = () => void runtime.ctx.resume()
  useEventListener(window, ['pointerdown', 'keydown'], resume, { passive: true })

  const midi = reactive<MidiStatus>({
    supported: WebMidiInput.supported,
    devices: [],
    error: null,
    permission: 'unknown',
    connected: false,
    connecting: false,
    async connect() {
      if (!midi.supported || midi.connected || midi.connecting) return
      midi.connecting = true

      try {
        midi.devices = await runtime.midi.connect()
        runtime.midi.select(settings.midiDeviceId)
        midi.connected = true
        midi.error = null
        midi.permission = 'granted'
      } catch (e) {
        midi.error = errorMessage(e)
        if (e instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(e.name))
          midi.permission = 'denied'
      } finally {
        midi.connecting = false
      }
    },
  })

  runtime.midi.onDevicesChange = (devices) => (midi.devices = devices)

  if (midi.supported) {
    // Only connect on load when access is already allowed. Otherwise wait for a click, so
    // Chrome's prompt shows up when the pianist expects it instead of being dismissed unseen.
    const { state, query } = usePermission('midi', { controls: true })
    void query().then((status) => {
      if (!status) return void midi.connect()

      watch(
        state,
        (s) => {
          midi.permission = s ?? 'unknown'
          if (s === 'granted') void midi.connect()
        },
        { immediate: true },
      )
    })
  }

  watchDebounced(
    settings,
    (s) => {
      void repos.settings.save(toRaw(s))
      runtime.piano.configure({ maxVoices: s.maxVoices, volume: s.volume })
      runtime.setKeyboardEnabled(s.keyboardInput)
      runtime.midi.select(s.midiDeviceId)
      runtime.remote.bindings = { ...toRaw(s.remote) }
    },
    { deep: true, debounce: 250 },
  )

  // Chrome decides silently, Firefox asks once.
  void navigator.storage?.persist?.()

  return { provide: { runtime, repos, audio, midi, settings } }
})
