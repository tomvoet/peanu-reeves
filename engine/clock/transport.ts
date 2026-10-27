export interface LoopRange {
  start: number
  end: number
}

/** Maps AudioContext time to song time. The only source of truth for playback position. */
export class Transport {
  playing = false
  tempo = 1
  loop: LoopRange | null = null

  private anchorCtx = 0
  private anchorSong = 0

  constructor(private readonly now: () => number) {}

  songTime(at = this.now()): number {
    return this.playing ? this.anchorSong + (at - this.anchorCtx) * this.tempo : this.anchorSong
  }

  ctxTimeAt(songSec: number): number {
    return this.anchorCtx + (songSec - this.anchorSong) / this.tempo
  }

  play(): void {
    if (this.playing) return
    this.anchorCtx = this.now()
    this.playing = true
  }

  pause(): void {
    if (!this.playing) return
    this.anchorSong = this.songTime()
    this.playing = false
  }

  /** Negative times are allowed for count-ins. */
  seek(songSec: number): void {
    this.anchorSong = songSec
    this.anchorCtx = this.now()
  }

  setTempo(factor: number): void {
    this.anchorSong = this.songTime()
    this.anchorCtx = this.now()
    this.tempo = factor
  }

  /** Wraps playback at the loop end. Returns true when a wrap happened. */
  tick(): boolean {
    if (!this.playing || !this.loop || this.songTime() < this.loop.end) return false
    this.seek(this.loop.start)
    return true
  }
}
