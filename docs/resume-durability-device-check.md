# Resume durability: the one check that needs a real iPhone

Last reviewed: 2026-07-28

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
  fix would be to record the position from a source that survives suspension. **The app will
  have told you so itself** — see the next section.
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

## If the player offers to "jump to about …", the answer is FAIL

The check above needs you to open Settings and read a diagnostic. There is also a reading you
cannot miss, because it appears on the player itself:

> **This was playing when the app closed, and about 5 min went unrecorded.**
> `Jump to about 32:07` ✕
> _An estimate from the time away and 1× speed. Your saved place is 27:07._

**Seeing this IS the failing answer to the open question above.** It appears only when the
last durable write was a hide-edge flush (`visibility-flush`/`pagehide-flush`) that caught
audio still playing, with nothing written after it and a projected advance over a minute. On
this device there is exactly one durable record per book and every write overwrites it, so
"the record still names the hide edge" is the same statement as "**neither cadence writer ran
once between the screen locking and the app dying**". That is precisely the both-suspended
case, observed rather than inferred, on the hardware the automated suite cannot reach.

So the check has two readings that must agree, and the affordance is the louder one:

| what you see                                | what it means                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| no offer, `media-tick`/`cadence-timer`      | a writer survived the backgrounding — **pass**, residual closed                   |
| the offer, `visibility-flush`               | both writers were frozen for the whole listen — **fail**, and this is the finding |
| the offer, but a cadence writer in Settings | the two witnesses disagree; report that, it is a defect in its own right          |

**What the offer does and does not do.** The app has already resumed at the position it
actually saved, and it will never move past that on its own — projecting a position forward
without the user asking would skip content they never heard, which is a blocker in this
codebase at any magnitude, and it would simply be wrong if iOS had stopped the audio early
rather than merely stopped recording it. The jump is a one-tap offer, labelled an estimate,
computed as `saved position + time away × playback rate`, clamped to the book. Dismissing it
is remembered for that specific gap (keyed by the write's own `writtenAt`), so it will not ask
again about the same lost stretch — a later suspension is a different loss and is offered
afresh.

For the measurement run, prefer the Settings readout: it names the mechanism. The offer is
what a real user gets, and what makes the failure survivable for them rather than silent.

The behavioural rows for all of this are `tests/resume/suspension-recovery.spec.ts` (R1 the
seeded signature, R2 that an ordinary background offers nothing, R3 that a dismissal sticks);
the detection rule and the projection arithmetic are `detectSuspendedSession` in
`src/lib/playback-core.ts`.
