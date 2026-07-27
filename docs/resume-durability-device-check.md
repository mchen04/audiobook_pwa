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

So the open question is precisely this, and nothing broader:

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
5. Reopen the app and read the position.

**Interpreting it:**

- Resumes within a few seconds of where the audio actually got to → at least one writer
  survives backgrounding. Nothing to do; the residual is closed.
- Resumes near the **30-second** mark — i.e. roughly where the screen locked, having lost
  the whole 5 minutes → both writers are suspended. Report that; it is a real defect and the
  fix would be to record the position from a source that survives suspension.
- Resumes **ahead** of where the audio was → report immediately. Skipping content the user
  never heard is treated as a blocker in this codebase regardless of size.

Run it once on wifi and once in airplane mode. Airplane mode matters because the server
write is unavailable there, so the local write is the only thing standing between you and a
lost position.
