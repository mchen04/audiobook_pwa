# Resume durability: the one check that needs a real iPhone

Everything else about resume position is measured automatically in WebKit by the
`resume-durability` Playwright project (`tests/resume/`). This file covers the single
question that project **cannot** answer, why it cannot, and how to settle it by hand in
about two minutes.

## What is already proven, automatically

On WebKit / iPhone 15, against the shipping build, drift between the position at the
moment the app died and the position after relaunch:

| how the app ended                       | wifi   | airplane mode |
| --------------------------------------- | ------ | ------------- |
| backgrounded                            | 123 ms | 124 ms        |
| swiped away (`pagehide`)                | 133 ms | 128 ms        |
| hard kill (SIGKILL, no callback at all) | 44 ms  | —             |
| reload                                  | 1 ms   | —             |
| left the player, then killed            | 99 ms  | —             |

Two independent writers record the position, and **each one alone** is enough:

- `timeupdate`, driven by the media pipeline — with the timer deleted: **234 ms**
- a 200 ms rescheduling timer — with `timeupdate` deleted: **40 ms**
- with **both** deleted: **9644 ms** — the whole session. This is the control that proves
  the rows above are graded on the writers and not on luck.

## What is NOT proven, and why

iOS may suspend a backgrounded page's JavaScript. The automated suite cannot observe this:

- Playwright's WebKit never reports a page as genuinely hidden. Measured directly —
  backgrounding the browser through the macOS window server leaves `document.visibilityState`
  at `"visible"` and fires no `visibilitychange` at all.
- `setActivityState` does not exist in `playwright-core`.
- Real Safari via `safaridriver` refuses a session without Safari ▸ Develop ▸
  _Allow Remote Automation_, and even with it, **macOS Safari does not reproduce iOS's
  background suspension** — so it would not answer this question either.
- The iOS Simulator needs Xcode; only the Command Line Tools are installed here.

### Why "installed PWA" is not a separate gap

It is reasonable to ask whether running from the Home Screen exercises code the suite never
touches. It does not. The app contains **no PWA-mode detection at all** — no
`navigator.standalone`, no `display-mode` query, and no `matchMedia` call anywhere in
`src/` (zero in the persistence layer). `display: "standalone"` appears once, in the
manifest, where it tells iOS how to launch the app; nothing reads it back.

So the installed PWA runs the same code as the suite, in the same engine, with the same
service worker, Cache Storage and IndexedDB. Installation changes the **operating system's**
treatment of the process — lifecycle and suspension — not the app's behaviour. That is the
one residual below, not a second one.

### The open question, stated as narrowly as it actually is

> While the PWA is backgrounded with the screen off and audio still playing, does iOS
> suspend **both** the 200 ms timer **and** the media element's `timeupdate`?

If either keeps firing, the position stays current to within ~250 ms and there is nothing
to fix. Only their **simultaneous** suspension loses ground, and the loss then scales with
the length of the background listen.

## The two-minute check on your phone

1. Install the app to the Home Screen (Share ▸ Add to Home Screen) and open it from there —
   not from a Safari tab. The suspension rules differ.
2. Start a book and let it play for **~30 seconds** so a position is well established.
3. Press the side button to lock the screen. **Keep audio playing.** Let it run for
   **5 minutes** — long enough that any loss is unmistakable rather than borderline.
4. Without unlocking, force-quit the app: swipe up into the app switcher and flick it away.
   (Force-quitting is deliberate — it denies the app any chance to write on the way out, so
   what you see is exactly what had already been saved.)
5. Reopen the app and go to **Settings ▸ Resume diagnostics**. It prints one line: the last
   position this device saved, **which writer saved it**, and how long ago. That line is the
   answer — you do not have to infer it from where the book resumes.

   ```
   32:07 · written by cadence-timer · 2s ago
   ```

**Interpreting the writer:**

| `written by`                                                          | what it means                                                                                                                           | verdict        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `media-tick`                                                          | the media pipeline's `timeupdate` kept firing while backgrounded                                                                        | **pass**       |
| `cadence-timer`                                                       | the 200 ms timer kept firing while backgrounded                                                                                         | **pass**       |
| `visibility-flush` / `pagehide-flush`                                 | the last write was the lifecycle handler at the moment the screen locked — **both cadence writers were suspended for the whole listen** | **fail**       |
| `pause`, `seek`, `rate-change`, `ended`, `book-switch`, `book-unload` | the listen you meant to measure did not happen, or you touched the transport                                                            | redo the check |
| `written by an earlier build`                                         | the build on the phone predates this readout                                                                                            | reinstall      |

A **pass** needs both halves: a writer of `media-tick` or `cadence-timer` **and** an age of a
few seconds, not five minutes. A recent age with `visibility-flush` means something wrote on
the way back in — foreground the app as little as possible before opening Settings, and
redo the check if in doubt.

**Cross-check against the resumed position**, which must still agree:

- Resumes within a few seconds of where the audio actually got to → at least one writer
  survives backgrounding. Nothing to do; the residual is closed.
- Resumes near the **30-second** mark — i.e. roughly where the screen locked, having lost
  the whole 5 minutes → both writers are suspended. Report that; it is a real defect and the
  fix would be to record the position from a source that survives suspension.
- Resumes **ahead** of where the audio was → report immediately, whatever the readout says.
  Skipping content the user never heard is treated as a blocker in this codebase regardless
  of size.

If the writer says pass and the position says fail (or the reverse), report **that** — the two
disagreeing is itself a defect, and the readout is the one making a claim about mechanism.

The readout reads `chapterline:position:*` in `localStorage`: `source` names the mechanism
that performed the write, and `writtenAt` is the wall clock at the moment of the write. It is
deliberately NOT `occurredAt`, which means "when this position was reached" and is preserved
across re-writes that carry no new position — see `momentThisPositionWasReached` in
`src/lib/playback-core.ts`. Both fields are optional, so records written by older builds still
parse; they simply cannot answer this question.

Run it once on wifi and once in airplane mode. Airplane mode matters because the server
write is unavailable there, so the local write is the only thing standing between you and a
lost position.
