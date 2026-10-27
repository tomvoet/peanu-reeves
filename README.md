# Peanu Reeves

A piano practice app I built for myself. Plug in a MIDI keyboard, open a piece and play along with falling notes. It has wait mode, hands separate, loops with a tempo ramp and stats per bar. Runs in Chrome or Edge and can be installed as a PWA.

Built with Nuxt 5 (SPA), Vite+, VueUse, Dexie, `@tonejs/midi` and `smplr` for the piano sound.

## Getting started

You need [Vite+](https://viteplus.dev) installed (`vp`).

```sh
vp install
vp run samples        # downloads the piano samples into public/samples (~65 MB, once)
vp run dev            # http://localhost:3000
vp run dev:https      # https on your network, for a tablet next to the piano
vp test               # unit tests
vp run test:e2e       # Playwright, starts its own server on :3123
vp check              # format and lint
vp run typecheck
vp run generate       # static build in .output/public
```

Web MIDI needs a secure origin. Localhost counts, anything else needs https.

Every push to `master` builds and deploys to [piano.tomvoet.dev](https://piano.tomvoet.dev) through GitHub Pages (`.github/workflows/deploy.yml`).

## Code

- `engine/` is the practice engine and has no Vue in it. Clock, MIDI input, piano audio, song parsing, note matching, stats and the canvas renderers.
- `engine/practice.ts` ties it together and runs the draw loop. Vue only polls a small status object for the toolbar.
- `db/` holds the Dexie schema and repositories.
- `app/` is the Nuxt side: library, practice, Free play, stats and settings.
- `tests/` has unit tests and a few Playwright smoke tests.

Everything runs on one clock, the audio clock corrected by `getOutputTimestamp()`. So a falling note hits the keyboard at the moment you hear it. The calibration page measures the rest (MIDI delay and your own reaction) and the matcher subtracts it. The hit window is ±150 ms in song time, which gets wider in real time when you practise slowly.

## Without a piano

Turn on "Computer keyboard plays notes" in Settings. `Z S X D C V …` and `Q 2 W 3 E R …` play two octaves from C3 and C4, `PgUp`/`PgDn` move the octave and left `Shift` is the sustain pedal.

Practice view shortcuts: `Space` play/pause, `R` restart, `←`/`→` bars, `↑`/`↓` tempo, `L` loop this bar, `Esc` clear loop, `F` focus mode, `N` sheet music, `O` options. Keys that also play notes need `Alt` while the computer keyboard is on.

You can also bind spare piano keys or pedals to play/pause, restart, bars and tempo (Settings › Control from the piano). Bound keys never make a sound or count as wrong.

## Hands

Hands come from track names if they say so ("right", "LH", "bass"), from the two tracks if there are exactly two, or else from smart separation. That looks for the easiest playable way through the piece. It rules out chords a hand can't reach and adds a cost for jumps, crossings and odd registers. You can fix single notes with "Fix hands" and the rest is worked out again around them.

`vp run eval:hands <folder>` compares the smart split with the files' own splits.

## Sheet music and drills

"Notes" shows a grand staff above the falling notes, right hand on treble and left on bass. Spacing follows time instead of proper engraving, notes snap to sixteenths and rests are left out. The key comes from the file or is guessed from the notes.

"Drill weak bars" takes the bars you keep missing, loops each one with a bar either side and runs the tempo ramp. One clean pass at full tempo moves you to the next spot.

## Takes and Free play

Every pass is saved as a take with timing, velocity and pedal. The last 10 per piece are kept, starred ones forever. You can replay a take on its own, against the score or against a starred take, and export it as `.mid`.

Free play (`F` in the library) records without a piece. It always keeps the last ten minutes, so you can save something you played before hitting record. Recordings can be trimmed, saved, exported or turned into a piece.

## Your data

Everything lives in the browser (IndexedDB and a bit of localStorage). Settings has backup, restore and a CSV export of all passes. The library nags you if you haven't backed up in two weeks.

If you link a folder, it gets rescanned on every launch. Chrome asks for permission again after a restart, the library has a button for that. Edited files keep their history.

Piano samples are served from this site, never from a third party, and cached after the first load.

## Sounds

Settings › Audio picks the sound. `vp run samples` downloads the sets, already converted to Ogg and M4A by [smpldsnds](https://github.com/smpldsnds), and the deploy does the same.

- Grand piano: [Splendid Grand Piano](https://github.com/sfzinstruments/SplendidGrandPiano), public domain samples by Akai.
- CP80, Wurlitzer EP200 and Pianet T: [Greg Sullivan's E-Pianos](https://github.com/sfzinstruments/GregSullivan.E-Pianos) by [Greg Sullivan](http://www.sullivang.net/), mapped by kinwie, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Converted from FLAC.
- FM piano: Yamaha TX81Z from the [Versilian Community Sample Library](https://github.com/sgossner/VCSL), CC0.

## License

MIT
