import { describe, expect, it } from 'vite-plus/test'
import { RemoteControl } from '../../engine/midi-input/remote'
import { InputEmitter, InputHub } from '../../engine/midi-input/types'

class FakeInput extends InputEmitter {
  on = (p: number) => this.emitNoteOn(p, 100, 0)
  off = (p: number) => this.emitNoteOff(p, 0)
  cc = (c: number, v: number) => this.emitControl(c, v, 0)
  pedal = (c: number, v: number) => this.emitPedal(c, v, 0)
}

function setup() {
  const remote = new RemoteControl()
  const hub = new InputHub()
  hub.intercept = remote.intercept
  const source = new FakeInput()
  hub.add(source)
  const played: number[] = []
  hub.onNoteOn((p) => played.push(p))
  return { remote, source, played }
}

describe('RemoteControl', () => {
  it('fires bound actions and swallows their notes', () => {
    const { remote, source, played } = setup()
    remote.bindings = { toggle: { kind: 'note', number: 21 } }
    let fired = 0
    remote.on('toggle', () => fired++)
    source.on(21)
    source.off(21)
    source.on(60)
    expect(fired).toBe(1)
    expect(played).toEqual([60])
  })

  it('fires a controller once per press and also handles pedal CCs', () => {
    const { remote, source } = setup()
    remote.bindings = { nextBar: { kind: 'cc', number: 80 }, restart: { kind: 'cc', number: 67 } }
    const log: string[] = []
    remote.on('nextBar', () => log.push('next'))
    remote.on('restart', () => log.push('restart'))
    source.cc(80, 127)
    source.cc(80, 100)
    source.cc(80, 0)
    source.cc(80, 127)
    source.pedal(67, 127)
    expect(log).toEqual(['next', 'next', 'restart'])
  })

  it('learns the next key or pedal without playing it', async () => {
    const { remote, source, played } = setup()
    const learned = remote.learn()
    source.on(22)
    expect(await learned).toEqual({ kind: 'note', number: 22 })
    expect(played).toEqual([])
    source.on(22)
    expect(played).toEqual([22])
  })
})
