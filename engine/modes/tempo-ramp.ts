export interface TempoRampConfig {
  enabled: boolean
  start: number
  step: number
  /** Clean passes needed before stepping up. */
  cleanPasses: number
  target: number
  /** Accuracy (0–1) a pass needs to count as clean. */
  threshold: number
  /** Failed passes in a row before the tempo drops a step. 0 never drops. */
  failPasses: number
}

export const DEFAULT_TEMPO_RAMP: TempoRampConfig = {
  enabled: false,
  start: 0.6,
  step: 0.05,
  cleanPasses: 2,
  target: 1,
  threshold: 0.95,
  failPasses: 3,
}

export interface RampState {
  tempo: number
  cleanStreak: number
  failStreak: number
}

/** `from` resumes a ramp that was already partway up. */
export function startRamp(config: TempoRampConfig, from?: number | null): RampState {
  const tempo = Math.max(config.start, from ?? config.start)
  return { tempo: Math.min(tempo, config.target), cleanStreak: 0, failStreak: 0 }
}

export function advanceRamp(
  config: TempoRampConfig,
  state: RampState,
  accuracy: number,
): RampState {
  const round = (t: number) => Math.round(t * 1000) / 1000

  if (accuracy < config.threshold) {
    const failStreak = state.failStreak + 1
    const floor = Math.min(config.start, config.target)
    if (config.failPasses > 0 && failStreak >= config.failPasses && state.tempo > floor) {
      return {
        tempo: Math.max(floor, round(state.tempo - config.step)),
        cleanStreak: 0,
        failStreak: 0,
      }
    }
    return { ...state, cleanStreak: 0, failStreak }
  }

  const cleanStreak = state.cleanStreak + 1
  if (cleanStreak < config.cleanPasses || state.tempo >= config.target) {
    return { ...state, cleanStreak, failStreak: 0 }
  }
  return {
    tempo: Math.min(config.target, round(state.tempo + config.step)),
    cleanStreak: 0,
    failStreak: 0,
  }
}
