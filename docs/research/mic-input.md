# Microphone input for Peanu Reeves: how Simply Piano and similar apps do it, the hard parts, and what it would take

*Research report, 2026-10-28. Tags used below: **[sourced]** means backed by the cited URL. **[inferred]** means our own engineering judgement or arithmetic. **[unverified]** means the claim comes only from search-result snippets, because the primary page could not be opened. Many primary hosts were blocked for direct fetch during the research (arxiv.org, patents.google.com, medium.com, help.joytunes.com, archives.ismir.net, developer.chrome.com, and others). Wherever a number rests on a search snippet, it is marked that way.*

---

## 1. TL;DR

- **No app solves this fully. They all ship microphone input as a convenience mode and push users to MIDI.** Flowkey says MIDI is "100% precise" and that its mic struggles on advanced pieces. Piano Marvel says its mic mode works "until around level 4" and keeps full assessment MIDI-only. Playground Sessions and Synthesia refuse to offer mic input at all. User reviews of Simply Piano, Yousician and Flowkey describe the same failures: chords missed, octaves confused, wrong notes accepted, fast or repeated notes dropped.
- **The insight you suggested is how the industry works.** Skoove, built with Fraunhofer IDMT, describes browser-based "multipitch validation" that checks whether the *predefined reference notes* were played, in order. JoyTunes (Simply Piano) patent filings describe recognition that takes "expected notes (if any)" as input, plus suppression of the app's own background music. Academic piano-tutoring systems all use the score as a prior. Score-informed checking turns an unsolved problem (blind polyphonic transcription) into a set of yes/no tests, one per expected pitch.
- **Chords are the main problem, and they collide with `chord: 'all'`.** The only vendor that publishes figures, Piano Marvel, claims about 99% for 2-note chords and about 90% for 3-note chords "under ideal conditions". That works out to a stalled wait-mode chord roughly every 10 chords. Mic mode needs a more lenient chord policy.
- **The second big problem is the app's own sound reaching the mic: backing, the other hand, the metronome.** It is the same instrument timbre the user is playing. Vendors mostly tell users to wear headphones. We have an advantage most of them may not use: the engine knows exactly which pitches it scheduled and when, so it can mask or discount them.
- **Browser capture is workable on desktop Chrome and Edge, if you turn off voice processing and verify it is off.** That means `echoCancellation`, `noiseSuppression` and `autoGainControl` all false, then checking `getSettings()`. Round-trip latency should be planned at **about 60-130 ms** until we measure it (the often-quoted 19 ms did not reproduce). Calibrate it with an automatic speaker-to-mic click loopback, stored separately from the MIDI `offsetMs`.
- **Recommended design: a DSP expected-pitch verifier.** An AudioWorklet feeds a ring buffer, a Worker computes per-pitch onset flux and harmonic salience on inharmonicity-stretched partials, and the results go into a new `MicInput extends InputEmitter`. The verifier is given the current expected chord and the app's own scheduled notes. Neural models (Basic Pitch, Onsets and Frames, Kong, Mobile-AMT) are offline, too slow, or not truly causal in the browser today. Keep them as a later layer that provides evidence, not decisions.
- **iPad matters more than it looks.** Chrome and Edge on iPadOS are WebKit underneath, so there is no Web MIDI, and the mic is the *only* input on iPad. WebKit's getUserMedia and AudioWorklet bugs apply there.
- **Rough effort: about 6-9 engineer-weeks to a usable beta** of monophonic plus simple chords, with headphones or ducking [inferred estimate]. Do an offline prototype on recordings *before* building the live pipeline. Do a patent freedom-to-operate review before shipping (JoyTunes, Yousician and Apple patents are relevant; their claim text has not been verified).

---

## 2. How the commercial apps do it, and what users say

| App | Platforms with mic | What is known about the method | Accuracy statements |
|---|---|---|---|
| **Simply Piano** (JoyTunes, now Simply Ltd) | iOS, Android | A proprietary on-device deep-learning engine called "MusicSense" that detects notes and rhythm on the client and must reject background noise [sourced: sdtimes, duns100]. The Medium "under the hood" posts say ML runs on the device inside a 60 fps game loop, and Part 2 mentions chords of up to 5 notes and speaker bleed [unverified: snippets only]. Patent US11670188B2 (filed 2021-07-29, granted 2023-06-06) *describes* filtering out the known backing track and giving feedback against expected notes or chords [sourced: description only]. Whether its *claims* cover this, and whether the shipping app uses expected notes, is **unverified**. US20220180767 / US12243437B2 describe echo cancellation, source separation and crowd-tuned per-device mic configuration. | Recommends headphones and warns against Bluetooth because of delay. MusicSense does not work with Bluetooth speakers [sourced: partners FAQ]. Reviews: chords not heard without MIDI; it "recognises the right notes, but lets the wrong notes pass" and accepts the wrong octave (italianpiano); usually fine but sometimes "absolutely terrible" (Pianist's Compass); eighth-note runs and repeated notes missed. |
| **Skoove** (with Fraunhofer IDMT) | Web, mobile | "Web-based polyphone real time pitch validation". "Multipitch validation" checks whether the student "has actually played the predefined reference notes correctly and in the correct order". It is designed to cope with noise, changing volume and out-of-tune pianos [sourced: Fraunhofer press release via search excerpt]. A co-founder said it compares input audio frequencies with the target notes to estimate a likelihood. **No paper, thresholds or accuracy figures are published.** | A 2026 review: two-hand passages worked well on an acoustic upright. Treat this as anecdote. |
| **Flowkey** | Web (including Safari and Firefox, mic only), mobile | Built on academic research into real-time recognition (their own history page). Fixed at A=440. Has a wait mode like ours. | Developer: "advanced pieces can sometimes be a challenge"; MIDI "100% precise"; brighter piano sounds are detected better. Recommends "Just Play" rather than wait mode for acoustic pianos because it is more forgiving. Reviews: wait mode misses correct notes; fast 16th notes are missed (Trustpilot, Jan 2026). **This is the strongest proof that browser mic detection is commercially viable.** |
| **Yousician** | Mobile, desktop | CTO Anssi Klapuri is a leading multipitch-estimation researcher who has spoken about real-time multipitch on mobile [sourced]. Patent US9218748B2 covers exercises with recognition of the instrument signal. **No public algorithm description.** Has a calibration and level-check screen. | Reviews: about 85-90% registration on single notes on an acoustic piano; an F major chord was never registered (TapSmart); works better on an acoustic upright than on a digital piano. Advice: lower app volume, headphones, turn off keyboard effects. |
| **Piano Marvel** | iOS only for mic | Not described. | **The only published polyphony numbers:** about 99% for 2 notes and about 90% for 3 notes "under ideal conditions". A 4-note release was promised, not confirmed shipped. Vendor marketing, no test set. Works "until around level 4". Advice: avoid heavy pedal, quiet room, device close to the piano. The web app requires MIDI for assessment. |
| **PianoGo** (La Touche Musicale) | Mobile | Not described. | Admits it "doesn't have a perfect result". Turn the piano up and the app down, use the default piano voice. |
| **Playground Sessions, Synthesia** | MIDI only | They chose not to do it, citing chord polyphony and poor rhythm measurement. | n/a |

**What this tells us [inferred]:**
1. Everyone ships mic mode with weaker guarantees and a strong push toward MIDI.
2. The "wrong notes pass" complaint fits a checker that only verifies expected pitches and never penalises extra ones. That is the known weakness of the score-informed approach, and we should design against it.
3. The vendors' practical fixes are environmental: headphones, play louder, tune to A440, use the default voice, avoid pedal. None of them describes clever playback cancellation publicly, although JoyTunes' patents describe it.
4. No independent accuracy measurement of any app's mic mode exists. Every number above is vendor-supplied or anecdotal.

---

## 3. The hard parts

### 3.1 Polyphony and harmonic overlap (chords, octaves, fifths)
- **Why it is hard.** Partials of notes in a chord land on the same frequencies. In an octave (C4+C5), *every* partial of C5 sits on an even partial of C4. In a fifth (C4+G4), every 2nd partial of G4 sits on every 3rd partial of C4 [inferred arithmetic; the octave case as a known hard pattern is sourced: Eurecom, NTU, Benetos 2012]. Chroma or template matching cannot see octaves at all (Müller and Weiß).
- **How others handle it.** Academic systems use per-pitch spectral templates with NMF and *per-pitch thresholds* chosen with knowledge of the score (Ewert/Wang/Müller/Sandler, ISMIR 2016; Wang/Ewert/Dixon, TASLP 2017). Benetos/Klapuri/Dixon (2012) also transcribe a synthesised version of the score and compare the two results, which cancels systematic octave errors. They reached a 93% weighted F-measure, but offline, on 6 Disklavier recordings, which tells us nothing about real-time use on a tablet. Apps do not say how they handle it, and users report octave confusion.
- **The hard number, as corrected.** Polytune (AAAI 2025) reaches 64.1% average error-detection F1 across 14 instruments. **On piano specifically, missed-note F1 is about 26.8%, extra-note F1 about 72.0%, and correct-note F1 about 90.1%.** These come from synthetically injected errors and an offline pipeline, so they do not transfer directly. Still, they show that *detecting a missing chord note is the weak case on piano*, and that is the case `chord: 'all'` depends on.
- **What we would do.** Score each expected pitch *together with* the pitches it is easily confused with: ±1 semitone, ±12, +19 and +24 semitones, notes from the previous chord, and whatever the app itself is playing. Use a small non-negative decomposition so that an expected C5 does not get credit for energy that C4's even partials explain. When an expected note's partials are all shared with another note that is sounding, require evidence from bins that are not shared, or use a lenient policy. Make mic-mode chord release configurable, for example "N−1 of N for chords of 3 or more, but always the lowest and highest note" [inferred].

### 3.2 Speaker bleed: the app's own piano audio reaching the mic
- **Why it is hard.** Backing, the other hand and the metronome come out of the same device, with the same piano timbre, often at the same pitches as the user's notes. Every one of those notes looks like a correct user note. In wait mode this is less of an issue, because the backing pauses at the hold point, but the other hand and metronome can still sound during play-along.
- **How others handle it.** Mostly with headphones (Simply Piano, which warns against Bluetooth) and with turning the app volume down (Yousician, PianoGo). JoyTunes' patents *describe* suppressing background music through echo cancellation and source separation, plus per-device speaker and filter settings tuned from crowd data. Whether the shipping app does this is unverified.
- **Browser AEC, as corrected.** Since Chrome and Edge 141, `echoCancellation` accepts `'all'` and `'remote-only'`. Chrome-wide AEC (desktop since roughly Chrome 111) uses Chrome's own playout, including Web Audio, as its reference [sourced: Chrome 141 notes; Zoom forum, unverified on the version]. Known gotchas: routing through a gain-0 node defeated cancellation, and re-routing produced a doubled echo about 20 ms late (discuss-webrtc). **No source anywhere covers how AEC3 behaves when the speaker and the user produce the same piano timbre at the same time.** The claim that it would suppress the user's notes is our inference and is untested. AEC also added latency in Kaufman's test.
- **What we would do.** (a) Recommend wired headphones as the default in mic mode. (b) Turn AEC off and do *score-aware masking*: the practice engine already knows every note it scheduled (`playlist()` / `scheduleAuto` → `piano.schedule(pitch, velocity, at, dur)`) and every metronome click (`scheduleClick`). Pass that schedule to the detector, and for each sounding app note either model it as a known component with a gain learned during calibration, or raise the threshold or exclude user credit on that pitch for about 100-300 ms plus the calibrated latency. (c) Offer "duck accompaniment around expected onsets" and "silence while waiting". (d) Run `echoCancellation: 'all'` as an A/B experiment only.
- **A codebase hazard [sourced from repo].** `Runtime` sends every `input.onNoteOn` straight to `this.piano.noteOn`. If mic detections take the same path, the app will play the detected note through the speakers, the mic will hear it, and you get a feedback loop with doubled sound. Mic notes must skip the live-monitor path.

### 3.3 Latency and timing alignment
- **Why it is hard.** There are four delays: mic capture, the browser's buffering, the analysis window (low notes need long windows), and any confirmation delay. None of them is reliably exposed. Chrome's `MediaTrackSettings.latency` reportedly always returns 0.01 (Kaufman).
- **The numbers, as corrected.** Kaufman's 19 ms best case (2016 MacBook, processing off, `latencyHint: 0`) did **not** reproduce later: a 2022 MacBook Air measured about 70 ms, and Kaufman himself got about 68 ms on Canary. A 2020 test saw Chrome at about 124 ms with run-to-run jitter. **Plan for about 60-130 ms round trip on desktop.** There are no published figures for Chrome on Android or for iPad. On the neural side, existing online piano transcription adds 128-320 ms (Hu et al., ISMIR 2025, confirmed), and real-time musical use needs under 30 ms.
- **How others handle it.** Vendors don't say. Piano Marvel has latency guides and says Bluetooth "ALWAYS adds delay".
- **What we would do.** Run an automatic loopback calibration: schedule clicks at known audible-clock times T (reusing `scheduleClick`), detect them in the mic stream, and store `micOffsetMs = median(detected − T)`. This number covers both the output and the input pipeline in the app's own time base, which matters because `audio-clock.ts` defines T as "audible now". It must be **separate from the MIDI `offsetMs`**. The Matcher currently has a single `offsetMs`, so either make it per-source or apply the mic offset inside `MicInput` before emitting. Re-run calibration on `devicechange`. The ±150 ms window absorbs residual jitter, but a 60-130 ms *uncompensated* mic delay would eat most of it.

### 3.4 Onsets vs. sustain: repeated notes, pedal, reverb
- **Why it is hard.** A note that is still ringing, sympathetic resonance with the pedal down, and room reverb all keep energy at a pitch. A re-strike of the same pitch only adds a small *rise*. Marolt and Divjak (ISMIR 2002) say repeated-note errors are very common in pedalled passages. Users report repeated notes and fast 16ths being missed (Simply Piano, Flowkey).
- **How others handle it.** Research models attack and decay separately (Cheng/Mauch/Benetos/Dixon, ISMIR 2016), uses power-scaled or energy-weighted spectral flux, and uses SuperFlux's maximum filter across frequency (up to 60% fewer false positives on vibrato material). Piano Marvel tells users to avoid heavy pedal.
- **What we would do.** Never treat steady energy as a note-on. For each pitch, compute positive log-magnitude flux at its partials against a max-filtered previous frame, and compare it with the decay predicted from the last strike on that pitch. Also require a broadband hammer transient near the time. Raise thresholds for pitches already sounding, and lower them when the score says a repeat is due. Do not try to detect the pedal.

### 3.5 Piano physics: inharmonicity, weak bass fundamentals, tuning
- **Why it is hard.** Partials are stretched: f_k = k·f0·√(1+B·k²), with B between about 1e-4 and 1e-3 in the bass. With B = 1e-3, the 10th partial is about 82 cents sharp of an exact harmonic [inferred arithmetic], so integer-harmonic templates miss upper bass partials. Bass fundamentals radiate weakly, and some device mics roll off the low end. A0 and A#0 are under 2 Hz apart, so separating them by the fundamental alone would need a window of about 0.6 s [inferred]. Home pianos are often detuned (cases of 25-100 cents flat are documented). A piano 50 cents flat sits exactly between keys.
- **How others handle it.** Flowkey and Simply require A=440 and tell users to tune the piano. Yousician has a calibration screen. Skoove says it handles out-of-tune pianos.
- **What we would do.** Put each pitch's analysis bins at stretched positions, using a default B curve per register. Identify bass notes from their 2nd-8th partials, where neighbouring semitones are about 6% apart, and accept slightly later decisions for low notes. Estimate a global tuning offset during calibration (circular mean of cents deviations) and keep adapting it from matched notes. That is cheap because the expected pitches are known. B and per-pitch templates can be refined optionally by playing a few notes per register.

### 3.6 Browser and OS signal processing
- **Why it is hard.** getUserMedia defaults to speech processing. Noise suppression and AGC treat a sustained tone as noise, so a held note fades and the gain pumps (discuss-webrtc). Windows 11 Voice Clarity can make music muffled or silent (RØDE support), and a page cannot turn it off. Constraints can be silently ignored, and `exact` constraints throw on some versions.
- **What we would do.** Request `{echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1}` without `exact`, log `getSettings()` and `getCapabilities()`, and show a warning if any processing is still on. Run a mic-check step with a held chord that detects pumping or an unnaturally fast decay, and link to OS instructions. Do not force the AudioContext `sampleRate`: Firefox throws, and Safari has distortion bugs. Resample inside the Worker if needed.

### 3.7 Digital pianos through their own speakers, and soft playing
- **Why it is hard.** Small built-in speakers cut the bass and distort, and layered voices smear the partials [inferred]. Reviewers find recognition worse on digital pianos than on acoustics (TapSmart). Soft passages played to a tablet mic across a room sit near the noise floor.
- **What we would do.** In onboarding, steer anyone with a digital piano to Web MIDI, which we already support well. Position mic mode as the path for acoustic pianos and for keyboards without MIDI. Show a level meter in the mic check.

### 3.8 Platform reach: iPad and iOS
- **Why it is hard.** Every browser on iPadOS is WebKit, including Chrome and Edge, and no non-WebKit engine has shipped there outside EU-only apps. There is no Web MIDI on iOS (caniuse). Known WebKit issues: `echoCancellation:false` gives stereo with only the left channel populated; getUserMedia switches the audio session so playback is about half as loud; AudioWorklet distortion bugs (251091, 251350); SharedArrayBuffer posted to an AudioWorklet not kept shared (bug 237144).
- **What we would do.** Treat iPad as a separate QA track where mic mode *is* the product. Down-mix and pick the louder channel, set `navigator.audioSession.type`, keep a postMessage fallback transport, and test on real devices early.

### 3.9 Wrong-note feedback and velocity/offset
- **Why it is hard.** A verifier that only checks expected pitches can't see extra notes, and blind extra-note detection is unreliable. Mic loudness depends on distance and gain, so absolute velocity is meaningless. Note-offs and pedal are much harder than onsets.
- **What we would do.** Emit `wrong` only for strong, isolated onsets at confusable neighbours that clearly beat the expected pitch's activation. Show this as soft feedback and **set `wrongBlocks: false` in mic mode**, because a spurious wrong note would freeze wait mode: the Matcher's `wrongHeld` set blocks until a noteOff that a mic may never produce. Emit a coarse relative velocity, and synthesise noteOff when partial energy decays or after the expected duration.

---

## 4. Approach options compared

| Approach | Accuracy (expected) | Detection latency | Effort | Browser feasibility | Notes |
|---|---|---|---|---|---|
| **A. Monophonic pitch tracker** (pitchy/MPM, YIN) | Fine for single loud notes; fails on chords by design; Gilbertson's sight-reader got about 80% when loud and was confused by decay [sourced] | Window must span several periods: over 70 ms for A0, and chordbook/tuner uses 186 ms buffers [sourced] | Days | Excellent: pure JS, 0BSD | Only good for single-note lessons. Not a foundation. |
| **B. Score-informed DSP verifier** (onset flux plus harmonic salience or small NMF over expected and confusable pitches) | No published per-note number for this setup [gap]. Research shows using the score is a large help. Expect good results for single notes and 2-note chords, weaker for 3+ notes, octaves and pedal [inferred] | About 20-60 ms analysis/confirmation plus device latency [inferred] | About 4-6 weeks to beta [inferred] | Good: AudioWorklet plus Worker, JS or WASM, cheap per frame | Closest to Skoove/Fraunhofer. Main weaknesses: false accepts on shared partials, and blindness to wrong notes. |
| **C. Neural blind transcription** (Onsets and Frames, Kong/ByteDance, hFT, Basic Pitch, Mobile-AMT) | Offline in-domain about 95-97 onset F1 (Kong 96.72; hFT 97.44). Drops out of domain (MAPS 82-88). Basic Pitch about 71 on MAESTRO (paper figure, model has changed since: **indicative only**) | Offline or chunked models: seconds. Online: 128-320 ms (Hu et al.). **Mobile-AMT's 174 ms is not truly causal** (its SE layers pool over a 10 s block, per Hu et al.), so its 96.3 F1 is not a causal result | Porting: weeks. Training a causal model: months | Poor today: Magenta.js about 0.5x real time and no Worker; basic-pitch-ts works on whole files with 2 s windows (about 0.2-0.35 s look-ahead with the stock scheme); no permissively licensed browser-ready causal piano model was found | Licences: Kong inference MIT (weights unclear); Onsets and Velocities demo GPLv3; essentia.js AGPL. |
| **D. Hybrid: DSP verifier plus neural onset evidence read only at expected pitches** | Likely best on pedal and reverb robustness, if the model's delay is acceptable [inferred] | max(DSP, model delay): about 100-350 ms with current models [inferred] | B plus 4-8 weeks [inferred] | Feasible with ORT-Web WASM in a Worker. WebGPU has a 1-5 s cold start [low-confidence source]. Multithreaded WASM needs COOP/COEP | A later phase, only if B's false-reject rate on pedalled or reverberant material is too high. |
| **E. Audio score-following** (online DTW, Matchmaker) | 41-59 ms average alignment error on piano (Dixon) | Tens of ms, lags | Medium | Feasible | Solves *where in the score am I*, which wait mode already knows. Could help play-along drift tolerance. Not a per-note checker. |

---

## 5. Recommended design for this codebase

### 5.1 Architecture

```
getUserMedia({echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1})
   │
   ▼
Runtime.ctx (existing single AudioContext, latencyHint 'interactive', default sample rate)
   MediaStreamAudioSourceNode ──► AudioWorkletNode 'mic-capture'  (NOT connected to destination)
                                    copies 128-frame blocks + currentFrame into
                                    SharedArrayBuffer ring (ringbuf.js); postMessage fallback
   │
   ▼
Worker 'mic-detector'
   - short STFT (1024–2048, hop 256 @48k)  → per-pitch onset flux (SuperFlux-style, stretched partials)
   - long STFT (4096–8192)                → harmonic salience / small NMF (warm-started, 3–10 iters)
   - candidate set = expected chord ∪ confusables (±1, ±12, +19, +24) ∪ previous chord ∪ app-playing notes
   - per-pitch adaptive thresholds, decay model for re-strikes, tuning offset, B curve
   - emits {pitch, strength, ctxTime} for confirmed expected onsets; low-confidence 'extra' events
   │
   ▼
engine/midi-input/mic.ts:  class MicInput extends InputEmitter
   - t = ctxTime − micOffsetSec  (loopback-calibrated)
   - emitNoteOn(pitch, coarseVelocity, t); synthetic emitNoteOff on decay / expected duration
   - setExpectation({ chord, upcoming, appSchedule })  ← fed by the practice engine
```

**Integration points (grounded in the repo):**
- **InputEmitter / InputHub.** Add `MicInput` to `runtime.input` the same way as `WebMidiInput`. **But mic notes must not reach `Runtime`'s live-monitor handler (`this.piano.noteOn`)**, or the detected note gets played back into the mic. Options: a `monitor: false` flag on the source, or a separate hub path. `RemoteControl.intercept` should probably ignore mic sources too.
- **Expected notes from the practice engine.** The detector needs to know what to listen for. `Matcher` already exposes `currentChord()` (in wait mode) and `remaining`. Add a small `expectations(now, horizonSec)` method returning pending notes whose `start` falls within roughly ±(tolerance + latency) of the current song time, converted to context time through `transport`. The practice session pushes it to `MicInput.setExpectation` each frame or on change. This creates a dependency from input back to the engine (the input is now score-aware), so keep it as a narrow interface (`ExpectationSource`) rather than letting `MicInput` import `Practice`.
- **The app's own playback.** `scheduleAuto` / `rescheduleAuto` (`piano.schedule(pitch, vel, at, dur)`) and `scheduleBeats` → `scheduleClick` are the full list of what the app will sound. Forward each scheduled event `{pitch, at, dur}` (and clicks) to the detector as the mask, or as known components.
- **Matcher options.** Mic mode needs: a per-source latency offset (today `offsetMs` is global; either make the Matcher source-aware or apply the mic offset in `MicInput` and set the Matcher's offset to 0 for mic); `wrongBlocks: false`; and a new `WaitOptions.chord` value such as `{ min: number | 'n-1', require: ('lowest'|'highest')[] }`. `currentChord()` and the release logic in `practice.ts` (around `holdPoint` / `blockedByWrongNotes`) would need to accept a partial chord as released.
- **Calibration.** `CalibrationCard.vue` already does click-and-tap calibration with `scheduleClick` and median offsets. Add a "Microphone" tab that plays clicks and detects them in the mic automatically (no tapping), then: noise floor → level check (held chord, detect pumping) → tuning (play A4 or any 3 notes) → optional per-register B and template refinement (one note per octave).
- **Hosting.** `nuxt.config.ts` sets no COOP/COEP today. SharedArrayBuffer and multithreaded ORT-Web need cross-origin isolation. Check that nothing loaded cross-origin (sample CDN, fonts) breaks under `require-corp`. Otherwise use the postMessage transport. That costs a few ms extra and the figure is unverified.

### 5.2 Phased plan (effort estimates are inferred, for one engineer familiar with the codebase)

| Phase | Scope | Effort | Exit criterion |
|---|---|---|---|
| **0. Data and offline prototype** | Record about 2-3 h: tablet, laptop and phone mics; acoustic upright plus a digital piano through its speakers; with and without app playback; pedalled pieces, repeated notes, octave and 3-4-note chords, deliberate mistakes. Use MIDI captured at the same time from a digital piano as ground truth. Add IDMT-PIANO-MM (432 recordings, 8 rooms, 3 phones and 2 tablets; Zenodo; **licence not checked**). Prototype the verifier in Python or Node against the score. Compare with Basic Pitch and the Kong model run offline as blind baselines. | 2-3 wk | Per-note accept/reject numbers per scenario; go/no-go. |
| **1. Live pipeline** | AudioWorklet, ring buffer and Worker; port the detector; `MicInput`; constraint verification; mic loopback latency calibration; no live monitoring of mic notes. Monophonic and 2-note chords. Headphones required. | 2-3 wk | Live false-reject/false-accept within a few points of offline on desktop Chrome and Edge. |
| **2. Real-world hardening** | Score-aware masking or ducking of app playback; tuning offset; re-strike decay model; mic-mode chord policy and `wrongBlocks:false`; mic-check UI; MIDI-first onboarding copy; Android tablet tuning. | 2-3 wk | Works without headphones in "mute accompaniment" mode; wait mode stalls on correct chords in less than about 1 in 20 chords on the test set [target, inferred]. |
| **3. iPad / WebKit** | Channel down-mix, audio session handling, postMessage transport, device QA. | 1-2 wk | Parity with desktop on 2 iPad models. |
| **4. (Optional) neural evidence** | Basic Pitch onset posteriors via ORT-Web WASM, read at expected pitches only. Or train a small causal CRNN on MAESTRO with heavy augmentation (room impulse responses, mic EQ, *our own playback mixed in*). | 4-8 wk+ | Only if phase 2 misses targets on pedalled or reverberant material. |

### 5.3 How to evaluate

- **Unit of measurement:** per expected note, not transcription F1.
  - **False-reject rate (FRR):** correct notes or chords that were played and not credited. In wait mode this is a stall, the worst user experience. Report it per note and *per chord* (chord release rate).
  - **False-accept rate (FAR):** expected notes credited when they were not played, for example a wrong octave, a neighbour key, or app bleed. Test this with deliberate-mistake takes and with "app plays, user silent" takes.
  - **Detection latency:** detected onset time minus MIDI ground-truth onset, as median and p95, per register.
  - **Wrong-note precision** for the advisory layer.
- **Conditions matrix:** device mic × piano type × playback (headphones / speaker / ducked) × material (single notes, 2-, 3- and 4-note chords, octaves, repeats, pedalled, pp).
- **Regression harness:** keep recordings plus aligned scores in the repo (or as LFS assets) and run the Worker's detector headlessly in Node over them in CI. The Matcher is already deterministic and testable.
- **Guardrail metrics in production (opt-in):** the share of wait-mode holds lasting more than 5 s while the mic shows onset energy at the expected pitches (likely false rejects); calibration offset drift; `track.stats` latency where available.

---

## 6. Risks, patents and licensing, open questions

### Risks
- **Accuracy ceiling.** No published per-note accuracy exists for any real-time expected-pitch verifier on phone or tablet mics. The best vendor claim (Piano Marvel, 90% on 3-note chords, ideal conditions) would still stall wait mode often. Mitigation: a lenient chord policy, and position mic mode as for beginners and acoustic pianos.
- **False accepts hide mistakes.** That is the documented Simply Piano complaint. Mitigation: confusable-pitch competition and an advisory wrong-note layer.
- **Speaker bleed without headphones.** AEC on same-timbre piano is unstudied. Masking may leave gaps when the user and the app play the same pitch. Mitigation: headphones, ducking, mute while waiting.
- **Latency variance** across devices, Bluetooth outputs, and OS voice effects (Windows Voice Clarity) the page can't control.
- **WebKit fragility on iPad**, where mic is the only path.
- **Scope creep toward neural models.** There is no browser-ready causal model. Treat it as research.

### Patents and licensing (not legal advice; claims not read)
- **JoyTunes / Simply:** US11670188B2 (granted 2023-06-06; its *description* covers backing-track suppression and feedback against expected notes; **its independent claims are unverified**), US12243437B2 / US20220180767 (crowd-tuned device configuration, AEC and source separation), US11900825 (mic capture configuration), US11893898B2 (named in research, not examined), and the older US9492756B2 (priority 2009; expiry around 2030-31 is an estimate). US11972693 and US10360889 ("latency enhanced note recognition in gaming", **assignee unconfirmed**) were also named.
- **Yousician:** US9218748B2 (exercises plus signal recognition; granted 2015-12-22; "about 2032" is an **unverified** 20-year estimate, maintenance status unchecked). Context: Yousician itself won dismissal of Ubisoft's music-teaching patent as an abstract idea, which weakens broad "exercise plus recognition" claims in general.
- **Apple:** US8309834B2 / US8592670B2 ("polyphonic note detection", filed 2010-04-12, about 2030 by estimate). **Corrected:** the abstract describes *blind* fundamental-plus-integer-harmonic detection. The link to a reference score appears only in press coverage, so it is *not* confirmed as close to score-informed verification. Our stretched-partial approach is also technically different.
- **Prior art that lowers risk:** Klapuri's harmonic salience (2006), Dessein et al. real-time NMF (2010), Benetos et al. score-informed tutoring (2012), Ewert et al. (ISMIR 2016), Wang et al. (2017), Dixon online DTW (2005), and Skoove/Fraunhofer's public 2016 description.
- **Action:** a freedom-to-operate review of the JoyTunes claims, especially "expected notes + BGM suppression", before shipping speaker-bleed suppression.
- **Code and model licences:** pitchy 0BSD; ringbuf.js MPL-2.0 [inferred, check]; basic-pitch(-ts) Apache-2.0; Kong inference package MIT (weights licence unknown); Onsets and Velocities demo GPLv3; essentia.js AGPLv3; MT3 Apache-2.0; hFT-Transformer licence unverified; IDMT-PIANO-MM licence for derived use unchecked.

### Open questions
1. Do the independent claims of US11670188 / US12243437 / US11900825 cover expected-note recognition or backing-music suppression?
2. What does Simply's "under the hood Part 2" actually say about MusicSense: model type, whether it is conditioned on the score, latency?
3. How does Chrome's AEC (`true` / `'all'`) behave on piano-on-piano double-talk? This needs an A/B test.
4. What is real mic round-trip latency on mid-range Android tablets and on iPad?
5. What FRR and FAR do users tolerate? Is "N−1 of N" acceptable to intermediate players?
6. How many calibration notes are needed for tuning, B and templates, and how well does that generalise across mic positions?
7. Will COOP/COEP break anything in the Nuxt PWA (sample and font hosts)?
8. Exact figures not verified: Basic Pitch on MAESTRO, Mobile-AMT table values, per-latency F1 in Hu et al. 2025.
9. Did Piano Marvel ship 4-note mic polyphony? Do independent accuracy measurements of any app's mic mode exist? (None found.)
10. How common are home acoustic pianos more than 30 cents off A440 among our users?

---

## 7. Sources

**Commercial apps and vendor docs**
- https://www.idmt.fraunhofer.de/en/Press_and_Media/press_releases/2016/skoove.html
- https://madeinshoreditch.co.uk/2015/10/17/sign-skoove-learn-piano-computer/
- https://rekkerd.org/skoove-music-learning-platform-now-works-wirelessly-with-acoustic-pianos/
- https://venturebeat.com/ai/skoove-launches-to-help-you-play-the-piano-backed-by-microsoft-ventures
- https://www.idmt.fraunhofer.de/en/institute/projects-products/songs2see.html
- https://viennatalk.mdw.ac.at/papers/Pap_01_59_Cano.pdf
- https://medium.com/joytunes/a-look-under-the-hood-of-simply-piano-part-1-7050d297f611
- https://medium.com/hellosimply/a-look-under-the-hood-of-simply-piano-part-2-3ba3cafa1bbf
- https://sdtimes.com/gamification/apps-find-new-ways-spark-interest-music/
- https://www.duns100.co.il/en/Simply_formerly_JoyTunes
- https://partners.hellosimply.com/faq
- https://www.hellosimply.com/blog/?p=4715
- https://piano-help.hellosimply.com/en/articles/12647864-enable-microphone-access-for-simply-piano
- https://piano-help.hellosimply.com/en/articles/6210608-ways-to-improve-note-recognition-in-simply-piano-for-ios-keyboard-electronic-piano
- https://help.joytunes.com/en/articles/6210583-ways-to-improve-note-recognition-in-simply-piano-for-ios-acoustic-piano
- https://help.joytunes.com/en/articles/3987010-bluetooth-headphones-and-bluetooth-midi
- https://www.weizmann.ac.il/WeizmannCompass/node/1756
- https://auditory.org/postings/2017/382.html
- https://dafx14.fau.de/program.html
- https://support.yousician.com/hc/en-us/articles/46277319890449-Piano-sound-recognition-issues
- https://support.yousician.com/hc/en-us/articles/360000535945-Choosing-your-set-up-for-singing
- https://help.flowkey.com/en/articles/651003-can-i-use-an-acoustic-piano-with-flowkey
- https://help.flowkey.com/en/articles/651023-which-browsers-are-compatible-with-flowkey
- https://help.flowkey.com/en/articles/412925-connect-your-instrument-with-your-laptop-pc-mac
- https://www.flowkey.com/en/piano-learning-technology
- https://apps.apple.com/us/app/flowkey-learn-to-play-piano/id1020357408?at=+&uo=4
- https://appshunter.io/ios/app/1020357408/reviews/9
- https://ca.trustpilot.com/review/flowkey.com?page=5
- https://pianomarvel.com/en/feature/microphone-assessment
- https://support.pianomarvel.com/portal/en/kb/articles/ios-microphone
- https://support.pianomarvel.com/portal/en/kb/articles/what-is-the-difference-between-assessment-mode-and-book-mode
- https://pianomarvel.com/article/audio-vs-midi-for-piano-whats-the-difference
- https://support.pianomarvel.com/portal/en/kb/articles/web-latency
- https://support.pianomarvel.com/portal/en/kb/articles/ios-latency
- https://latouchemusicale.crunch.help/en/piano-go/better-piano-note-recognition-recommendations
- https://www.musicradar.com/reviews/playground-sessions-review
- https://www.musicradar.com/reviews/flowkey-review
- https://forums.playgroundsessions.com/viewtopic.php?p=27745
- https://www.synthesiagame.com/forum/viewtopic.php?f=12&t=179

**Reviews and user reports**
- https://www.italianpiano.com/piano/review-of-simply-piano-app-for-learning-to-play-the-piano/
- https://pianistscompass.org/reviews/apps/simply-piano/
- https://pianistscompass.com/?p=9588
- https://justuseapp.com/en/app/1019442026/simply-piano-by-joytunes/reviews
- https://www.pianodreamers.com/simply-piano-review/
- https://beardedskeptic.com/review/simply-piano-review/
- https://www.masterpiano.com/yousician-review
- https://www.tapsmart.com/apps/piano-yousician-virtual-piano-tutor-designed-teachers/
- https://hackernoon.com/best-piano-learning-apps-in-2026-an-in-depth-comparison-of-music-education-technology
- https://unstar.app/blog/yousician-simply-piano-flowkey-fender-play-music-learning-apps-ranked-2026
- https://www.bleepingcomputer.com/offer/deals/this-piano-lesson-app-gives-you-live-feedback-and-its-on-sale-for-7999/

**Patents and legal**
- https://patents.google.com/patent/US11670188B2/en
- https://patents.justia.com/patent/11670188
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11670188
- https://www.freepatentsonline.com/y2022/0172638.html
- https://patents.google.com/patent/US20220180767A1/en
- https://www.freepatentsonline.com/y2022/0180767.html
- https://patentsgazette.uspto.gov/week09/OG/html/1532-1/US12243437-20250304.html
- https://patents.google.com/patent/US11900825
- https://patents.justia.com/assignee/joytunes-ltd
- https://patents.google.com/patent/WO2011030225A3/en
- https://patents.google.com/patent/US9492756
- https://patents.google.com/patent/US9218748B2/en
- https://www.9235.net/patent/US9218748B2.html
- https://patents.google.com/patent/WO2012146829A1/da
- https://patents.google.com/patent/US9767705B1/en
- https://patents.google.com/patent/US8309834B2/en
- https://patents.justia.com/patent/8309834
- https://patents.google.com/patent/US8592670B2/en
- https://www.google.ca/patents/US20110247480
- https://appleinsider.com/articles/12/11/13/apple-patent-could-bring-polyphonic-tuning-to-logic-pro
- https://patents.google.com/patent/US20130233152A1/en
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10360889
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10733900
- https://www.eff.org/deeplinks/2020/08/guitar-villain-ubisoft-patents-basic-teaching-techniques
- https://www.patentarcade.com/?p=5497

**Score-informed detection, onsets, multipitch, alignment**
- https://archives.ismir.net/ismir2016/paper/000123.pdf
- https://www.researchgate.net/publication/305496136_Score-Informed_Identification_of_Missing_and_Extra_Notes_in_Piano_Recordings
- https://www.audiolabs-erlangen.de/content/05_fau/professor/00_mueller/03_publications/2016_EwertWMS_ScoreDeviation_ISMIR_ePrint.pdf
- https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2017/WangEwertDixon-TASLP2017.pdf
- https://zenodo.org/records/1418317
- https://openaccess.city.ac.uk/2094
- https://openaccess.city.ac.uk/id/eprint/2094/1/1569573877.pdf
- https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2012/Benetos-Klapuri-Dixon-EUSIPCO2012a.pdf
- https://code.soundsoftware.ac.uk/projects/score-informed-piano-transcription-dataset
- https://arxiv.org/pdf/2501.02030
- https://ojs.aaai.org/index.php/AAAI/article/view/34539
- https://hal.archives-ouvertes.fr/hal-00708682
- https://hal.archives-ouvertes.fr/hal-00708805
- https://dblp.org/rec/conf/ismir/DesseinCL10
- https://www.audiolabs-erlangen.com/resources/aps-w23/papers/2012_EwertMueller_ScoreConstrainedNMF_ICASSP.pdf
- https://www.ismir2015.uma.es/articles/94_Paper.pdf
- https://www.ismir2015.uma.es/articles/99_Paper.pdf
- https://doaj.org/article/56a727e350ac4bffb77b7e875814fd2a
- https://archives.ismir.net/ismir2016/paper/000085.pdf
- https://code.soundsoftware.ac.uk/projects/decay-model-for-piano-transcription
- https://qmro.qmul.ac.uk/xmlui/handle/123456789/18421
- https://labsites.rochester.edu/air/publications/li2016AnApproach.pdf
- https://labsites.rochester.edu/air/publications/li2015score_poster.pdf
- https://dafx.de/paper-archive/details/_kscRgr98aSFW4l-j1YJuA
- https://dafx.de/paper-archive/details/0oee-99Z88WL7pSo749gcA
- https://dafx.de/paper-archive/details/CJtCPXOU6zutzT4FFf8BAA
- https://github.com/CPJKU/SuperFlux
- https://madmom.readthedocs.io/en/v0.16/modules/features/onsets.html
- https://archives.ismir.net/ismir2012/paper/000049.pdf
- https://archives.ismir.net/ismir2006/paper/000125.pdf
- https://essentia.upf.edu/reference/std_MultiPitchKlapuri.html
- https://dafx.de/paper-archive/details/o-kAKlRZ1QVrnYxd28nF0g
- https://archives.ismir.net/ismir2005/paper/000002.pdf
- https://ebooks.iospress.nl/pdf/doi/10.3233/978-1-58603-891-5-241
- https://arxiv.org/pdf/2510.10087
- https://arxiv.org/abs/2505.05078
- https://arxiv.org/pdf/2205.03247
- https://arxiv.org/pdf/2507.12175
- https://www.audiolabs-erlangen.com/fau/professor/mueller/teaching/2022w_mpa/MPA_material/data/2021_Mueller_MPA_ChordRecognition.pdf
- https://archives.ismir.net/ismir2002/paper/000042.pdf
- https://krishnasubramani.web.illinois.edu/data/Energy-Weighted%20Multi-Band%20Novelty%20Functions%20for%20Onset%20Detection%20in%20Piano%20Music.pdf
- https://eurecom.fr/publication/2478/download/cm-schuan-080517.pdf

**Piano acoustics**
- https://www.eurecom.fr/publication/2739/download/cm-publi-2739.pdf
- https://scholars.lib.ntu.edu.tw/signposting/describedby/af49c0b3-2875-4d07-9b50-5cbdc58cfa80
- https://typeset.io/pdf/multipitch-estimation-of-piano-sounds-using-a-new-3otugyvfb2.pdf
- https://typeset.io/pdf/a-parametric-method-for-pitch-estimation-of-piano-tones-55u11yj4ug.pdf
- https://researchportal.tuni.fi/en/publications/multiple-fundamental-frequency-estimation-based-on-harmonicitiy-a/
- https://dornsife.usc.edu/sergey-lototsky/wp-content/uploads/sites/211/2023/06/Musical-string-inharmonicity-Chris-Murray.pdf
- https://www.academia.edu/22085383/Fast_automatic_inharmonicity_estimation_algorithm
- https://dafx.de/paper-archive/details/fwG1bTohHdW3B3zV01Rxvw
- https://new.eurasip.org/Proceedings/Eusipco/Eusipco2012/Conference/papers/1569585169.pdf
- https://my.ptg.org/discussion/lowest-fundamental
- https://my.ptg.org/discussion/dispelling-the-myth-of-the-missing-fundamental
- https://hydrogenaudio.org/index.php?msg=876226
- https://groups.google.com/g/audiotool-discussion-group/c/G_J7kg6u7QQ
- https://groups.google.com/g/pianotech/c/yjUdWAyLY9o
- https://librosa.org/doc/0.11.0/generated/librosa.A4_to_tuning.html
- https://iris.unibs.it/retrieve/ddc633e2-da4b-4e2e-e053-3705fe0a4c80/DDLM_ISISPA-2013_PUBLISHED.pdf
- https://ismir2024program.ismir.net/lbd_496.html

**Neural transcription models**
- https://arxiv.org/abs/2010.01815
- https://github.com/bytedance/piano_transcription
- https://pypi.org/project/piano-transcription-inference/
- https://www.scriptbyai.com/ai-piano-transcription-pianolyze/
- https://arxiv.org/abs/2307.04305
- https://ismir2023program.ismir.net/static/posters/72.pdf
- https://magenta.github.io/magenta-js/music/
- https://magenta.tensorflow.org/oaf-js
- https://groups.google.com/a/tensorflow.org/g/magenta-discuss/c/I1O0Z5YFYWE
- https://arxiv.org/abs/1710.11153
- https://engineering.atspotify.com/2022/6/meet-basic-pitch
- https://github.com/spotify/basic-pitch
- https://github.com/spotify/basic-pitch/issues/96
- https://github.com/spotify/basic-pitch/issues/171
- https://github.com/spotify/basic-pitch-ts
- https://pypi.org/project/basic-pitch
- https://arxiv.org/html/2203.09893v2
- https://github.com/magenta/mt3
- https://researchr.org/publication/KusakaM24
- https://eurasip.org/Proceedings/Eusipco/Eusipco2024/pdfs/0000036.pdf
- https://arxiv.org/abs/2509.07586
- https://arxiv.org/html/2509.07586v1
- https://ismir2025program.ismir.net/poster_339.html
- https://zenodo.org/records/17706339
- https://research.jku.at/en/publications/exploring-system-adaptations-for-minimum-latency-real-time-piano-/
- https://arxiv.org/abs/2303.04485
- https://github.com/andres-fr/iamusica_demo
- https://scholarworks.sogang.ac.kr/item/1d425155-db50-421e-8e1a-23bfe266f0eb
- https://ismir2024program.ismir.net/poster_18.html
- https://arxiv.org/abs/2404.06818
- https://github.com/jdasam/online_amt
- https://arxiv.org/abs/2402.01424
- https://archives.ismir.net/ismir2022/paper/000057.pdf
- https://github.com/damrsn/neuralnote
- https://github.com/fschuh/piano-transcription-engine
- https://huggingface.co/bulpara/piano-to-score-onnx
- https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html
- https://github.com/tensorflow/tfjs/issues/8212

**Evaluation data**
- https://zenodo.org/record/7544248
- https://idmt.fraunhofer.de/en/publications/datasets/piano-mm.html
- https://jakobabesser.github.io/Abesser_2022_DMRN.pdf

**Browser audio, latency, AEC, WebKit**
- https://developer.chrome.com/release-notes/141
- https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/141
- https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation
- https://developer.chrome.com/blog/more-native-echo-cancellation
- https://developer.chrome.com/blog/disabling-hardware-noise-suppression/
- https://devforum.zoom.us/t/issupportchromewideaec-sniffs-browser-name-version-breaking-echo-cancellation-on-microsoft-edge/145288
- https://groups.google.com/g/discuss-webrtc/c/v592nFc4cO4
- https://groups.google.com/g/discuss-webrtc/c/U2OMxSaCjXk
- https://groups.google.com/g/discuss-webrtc/c/PDZYMzAI-_Y
- https://groups.google.com/g/discuss-webrtc/c/FCz_d7jZNSM
- https://docs.atmoky.com/known-issues
- https://www.github.com/webrtc/samples/issues/1243
- https://chromewebstore.google.com/detail/original-sound/ffhniinhbjmjakiabdojmfehdhnbcmdh
- https://help.rode.com/hc/en-us/articles/14263964951311-Understanding-Noise-Suppression-and-Vocal-Isolation-in-Windows-11
- https://www.jefftk.com/p/browser-audio-latency
- https://www.jefftk.com/p/audioworklet-latency-firefox-vs-chrome
- https://jefftk.com/p/web-audio-echo
- https://www.lesswrong.com/posts/ooXEzrX7Y9Go6D7st/browser-audio-latency
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/media/latency_tracing.md
- https://groups.google.com/a/chromium.org/g/blink-dev/c/xcGJyic7ttI
- https://groups.google.com/a/chromium.org/g/Blink-dev/c/i4c1unRSmcE
- https://developer.chrome.com/blog/audio-worklet-design-pattern
- https://github.com/padenot/ringbuf.js
- https://emscripten.org/docs/api_reference/wasm_audio_worklets.html
- https://bugzilla.mozilla.org/show_bug.cgi?id=1725336
- https://bugzilla.mozilla.org/show_bug.cgi?id=1674892
- https://bugs.webkit.org/show_bug.cgi?id=251091
- https://bugs.webkit.org/show_bug.cgi?id=237144
- https://bugs.webkit.org/show_bug.cgi?id=281978
- https://bugs.webkit.org/show_bug.cgi?id=107250
- https://caniuse.com/midi
- https://developer.mozilla.org/docs/Web/API/AudioSession/type
- https://gigazine.net/gsc_news/en/20260618-blink-on-ios
- https://9to5google.com/2024/02/02/google-chrome-blink-ios-browser-engine/
- https://github.com/ianprime0509/pitchy
- https://github.com/chordbook/tuner
- https://github.com/davidgilbertson/sight-reader
- https://github.com/qiuxiang/aubiojs
- https://meyda.js.org/reference/interfaces/Meyda.default.html
- https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/

**Repository files referenced:** `/home/user/peanu-reeves/engine/midi-input/types.ts`, `/home/user/peanu-reeves/engine/midi-input/web-midi.ts`, `/home/user/peanu-reeves/engine/matcher/matcher.ts`, `/home/user/peanu-reeves/engine/practice.ts`, `/home/user/peanu-reeves/engine/runtime.ts`, `/home/user/peanu-reeves/app/components/CalibrationCard.vue`, `/home/user/peanu-reeves/nuxt.config.ts`