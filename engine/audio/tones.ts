export interface Tone {
  readonly name: string
  readonly credit: string
  /** smplr ElectricPiano name the samples come from; the grand uses smplr's own preset. */
  readonly upstream?: string
}

export const TONES = {
  grand: { name: 'Grand piano', credit: 'Splendid Grand Piano, public domain samples by Akai' },
  cp80: {
    name: 'Electric grand (CP80)',
    credit: 'Yamaha CP80 by Greg Sullivan, CC BY 3.0',
    upstream: 'CP80',
  },
  wurlitzer: {
    name: 'Wurlitzer EP200',
    credit: 'Wurlitzer EP200 by Greg Sullivan, CC BY 3.0',
    upstream: 'WurlitzerEP200',
  },
  pianet: {
    name: 'Pianet T',
    credit: 'Hohner Pianet T by Greg Sullivan, CC BY 3.0',
    upstream: 'PianetT',
  },
  fm: {
    name: 'FM piano (TX81Z)',
    credit: 'Yamaha TX81Z FM Piano from the Versilian Community Sample Library, CC0',
    upstream: 'TX81Z',
  },
} as const satisfies Record<string, Tone>

export type ToneId = keyof typeof TONES

export const DEFAULT_TONE: ToneId = 'grand'
