/** Returns a function that silences the click if it has not sounded yet. */
export function scheduleClick(ctx: AudioContext, time: number, accent = false): () => void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.frequency.value = accent ? 1760 : 1320
  gain.gain.setValueAtTime(0.0001, time)
  gain.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, time + 0.002)
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06)
  osc.connect(gain).connect(ctx.destination)
  osc.start(time)
  osc.stop(time + 0.07)

  return () => {
    try {
      osc.stop()
    } catch {}
  }
}
