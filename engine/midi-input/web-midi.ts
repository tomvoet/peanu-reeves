import { InputEmitter, type ClockMapper } from './types'

export interface MidiDevice {
  id: string
  name: string
}

interface HeldInput {
  notes: Set<number>
  pedals: Set<number>
}

const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const CONTROL_CHANGE = 0xb0
/** Sustain, sostenuto and soft pedal. */
const PEDAL_CCS: ReadonlySet<number> = new Set([64, 66, 67])

export class WebMidiInput extends InputEmitter {
  private access: MIDIAccess | null = null
  private deviceId = 'all'
  /** Held notes and sustain per port, released if the port disappears. */
  private readonly held = new Map<string, HeldInput>()

  onDevicesChange: ((devices: MidiDevice[]) => void) | null = null

  constructor(private readonly toClock: ClockMapper) {
    super()
  }

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator
  }

  async connect(): Promise<MidiDevice[]> {
    this.access = await navigator.requestMIDIAccess()
    this.access.onstatechange = (e) => {
      const { port } = e
      if (port?.type === 'input' && port.state === 'disconnected') this.releasePort(port.id)
      this.bind()
      this.onDevicesChange?.(this.devices)
    }

    this.bind()
    return this.devices
  }

  get devices(): MidiDevice[] {
    return Array.from(this.access?.inputs.values() ?? [], (i) => ({
      id: i.id,
      name: i.name ?? i.id,
    }))
  }

  select(deviceId: string): void {
    this.deviceId = deviceId
    this.bind()
  }

  disconnect(): void {
    for (const input of this.access?.inputs.values() ?? []) input.onmidimessage = null
    this.access = null
  }

  private bind(): void {
    for (const input of this.access?.inputs.values() ?? []) {
      const active = this.deviceId === 'all' || this.deviceId === input.id
      input.onmidimessage = active ? (e) => this.handle(e, input.id) : null
      if (!active) this.releasePort(input.id)
    }
  }

  private releasePort(id: string): void {
    const held = this.held.get(id)
    if (!held) return

    const t = this.toClock(performance.now())
    for (const pitch of held.notes) this.emitNoteOff(pitch, t)
    for (const cc of held.pedals) this.emitPedal(cc, 0, t)
    this.held.delete(id)
  }

  private handle(e: MIDIMessageEvent, portId: string): void {
    const data = e.data
    if (!data || data.length < 2) return

    const status = data[0]! & 0xf0
    const a = data[1]!
    const b = data[2] ?? 0
    const t = this.toClock(e.timeStamp)
    let held = this.held.get(portId)
    if (!held) this.held.set(portId, (held = { notes: new Set(), pedals: new Set() }))

    if (status === NOTE_ON && b > 0) {
      held.notes.add(a)
      this.emitNoteOn(a, b, t)
    } else if (status === NOTE_OFF || status === NOTE_ON) {
      held.notes.delete(a)
      this.emitNoteOff(a, t)
    } else if (status === CONTROL_CHANGE && PEDAL_CCS.has(a)) {
      if (b >= 64) held.pedals.add(a)
      else held.pedals.delete(a)
      this.emitPedal(a, b, t)
    } else if (status === CONTROL_CHANGE) {
      this.emitControl(a, b, t)
    }
  }
}
