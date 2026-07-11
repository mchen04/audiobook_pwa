# iPhone PWA verification

Chapterline has a repeatable iPhone-shaped WebKit gate and a short physical-device
gate. The automated run catches Safari engine differences in auth cookies, the
Files picker, MP3 parsing, device storage, media range requests, playback, seeking,
reloads, and offline playback. A physical iPhone remains authoritative for the
Home Screen container and OS-level audio controls.

## Automated WebKit gate

Install WebKit once, then run the scenario:

```sh
pnpm exec playwright install webkit
pnpm test:e2e:ios
```

The test builds and starts the production app, uses Playwright's iPhone 15 WebKit
profile, exposes `navigator.standalone` as an installed Home Screen app does, and
chooses `tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3` through the file
picker. It then verifies:

1. Account creation retains a WebKit session.
2. An MP3 chosen from the simulated Downloads folder imports into device storage.
3. Online playback starts, advances, seeks, and survives a page relaunch.
4. The production service worker controls the page.
5. With all ordinary network requests blocked, the Downloads UI opens the stored
   book and WebKit plays it through the service worker's ranged media response.
6. No uncaught page or console errors occurred before the deliberate network cut.

`BETTER_AUTH_URL` must exactly match `PLAYWRIGHT_BASE_URL` (both default to
`http://localhost:3000`). Local HTTP cookies remain non-Secure; deployed HTTPS
cookies remain Secure.

## Physical iPhone release gate

Use the HTTPS deployment intended for release. Apple documents the install flow as
Safari → Share → Add to Home Screen → enable **Open as Web App** → Add.

1. Save a known-good MP3 to **Files → Downloads** on the iPhone.
2. Open the deployment in Safari, install it, close Safari, and launch only from
   the new Home Screen icon.
3. Sign in, tap **Choose MP3**, choose the file from Downloads, and wait for the
   imported book to appear.
4. Open it; play, pause, seek to the middle, change speed, lock the phone, and
   confirm audio continues and the lock-screen play/pause control works.
5. Force-quit the web app, enable Airplane Mode, relaunch from the Home Screen,
   open **Downloads**, then play and seek the same book.
6. Disable Airplane Mode, relaunch once, and confirm the saved position remains.

If anything fails, enable **Settings → Apps → Safari → Advanced → Web Inspector**,
connect the iPhone to this Mac, trust it, and inspect the foreground app from
Safari's **Develop → iPhone → Home Screen Web Apps** menu. Inspect the service
worker separately under that device's **Service Workers** section. Capture the
first console error and the failing `/offline-media/…` response, including its
status and `Range`/`Content-Range` headers.

Apple references:

- <https://support.apple.com/guide/iphone/iphea86e5236/ios>
- <https://developer.apple.com/documentation/safari-developer-tools/inspecting-ios>
