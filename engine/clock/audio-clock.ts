export interface AudioClock {
  /** Context time of the sample reaching the speakers right now. */
  now(): number
  /** Maps a DOM/MIDI event timestamp (performance.now domain) onto the same scale. */
  fromPerf(perfMs: number): number
}

/**
 * `currentTime` jumps once per audio callback and runs ahead of what is audible.
 * Extrapolating the output timestamp gives a smooth clock aligned with what the player hears,
 * and a note scheduled at context time T is heard when this clock reads T.
 */
export function createAudioClock(ctx: AudioContext): AudioClock {
  const fromPerf = (perfMs: number): number => {
    const ts = ctx.getOutputTimestamp()

    if (ctx.state !== 'running' || !ts.performanceTime || ts.contextTime === undefined) {
      return ctx.currentTime - (performance.now() - perfMs) / 1000
    }
    return ts.contextTime + (perfMs - ts.performanceTime) / 1000
  }

  return { now: () => fromPerf(performance.now()), fromPerf }
}
