# Operations

## Deployment shape

- Single Next.js instance (`pnpm build && pnpm start`) behind HTTPS. The
  service worker and installability require a secure origin (localhost counts
  for development).
- Set `BETTER_AUTH_URL` to the public origin; mutation requests from any other
  origin are rejected.
- The server stores metadata only; audio bytes live in each device's browser
  storage. There is no object storage to provision.
- Auth rate limiting is in-memory and assumes a single instance. Multi-instance
  deployments need a shared store (Better Auth supports database storage at
  ~2 extra database round trips per auth request).
- Session validation is authoritative against Postgres so password resets and
  explicit revocations take effect immediately on every API route.
- Postgres: run `pnpm db:migrate` before starting a new build. Migrations are
  ordered, idempotent, and verified to apply from an empty database. The app
  never mutates schema at runtime.
- Email: set both `RESEND_API_KEY` and `MAIL_FROM` to enable password resets in
  production; reset requests fail closed when delivery is not configured.
  Development captures expire after one hour in `.data/mail/`. Reset tokens
  are single-use, expire in 30 minutes, and revoke other sessions on success.
- Rotate the development Neon credential before any public deployment.

## Backup and restore

- **Database**: Neon branch snapshots or `pg_dump`. All server-side state
  lives in Postgres; a database restore is a full server restore.
- **Audio**: the MP3 files are the user's own — the app never holds the only
  copy. After any restore (or on a new device), opening a book prompts for the
  original file and verifies it by size and fingerprint before attaching.
- Browser storage can be evicted by the OS under pressure; the original files
  remain the durable copy. The app requests persistent storage at import.

## Data lifecycle

- Book deletion: the rows cascade server-side and the client removes the
  device-local bytes in the same flow.
- Account deletion: requires the email and current password; cascades every row,
  expires the session cookie, and clears the device's local data for that user
  (local books, queues, positions, preferences).
- Export: `GET /api/account/export` returns all metadata, chapters, progress,
  bookmarks, collections, tags, sessions, and preferences as JSON. Audio bytes
  are the user's own files and are not duplicated.

## Known platform limitations

- iOS Safari installs PWAs via Share → Add to Home Screen; there is no install
  prompt event, and background audio controls are more limited than Chromium's
  Media Session surface. Run the automated WebKit gate and the physical-device
  release checklist in `docs/ios-pwa-testing.md` before shipping changes to
  authentication, imports, storage, service workers, or playback.
- Media Session action support varies by browser; unsupported actions are
  feature-detected and skipped without affecting playback.
- Browsers may evict Cache Storage under storage pressure; the app requests
  persistent storage when importing, clears stale download metadata when the
  matching media entry is gone, and surfaces an original-file reattach flow
  instead of pretending the book is playable.
- Listening history is recorded only while online by design; it is a nicety,
  not queued state.

## Troubleshooting

- **Stale UI after deploy**: the service worker takes over on the next
  navigation (skipWaiting + clients.claim); hashed chunks keep old pages
  working. If a client ever shows chunk 404s, one reload fixes it — that state
  only arises when the server was restarted mid-deploy against a half-written
  `.next`.
- **Import fails with "not a valid MP3"**: the file must be a real MPEG
  Layer 3 file; renamed non-MP3s are rejected by the in-browser parser.
- **"This device does not have enough free storage"**: the import is bounded
  by browser storage quota — free space or use a device with more room.
- **A book shows "Attach MP3" on another device**: expected — audio bytes
  never sync; attach the original file once per device.
- **Progress seems stuck on one device**: check the response of a manual
  progress PATCH — a 409 `stale-event` means another device has fresher state,
  which is the deterministic conflict rule working as intended.
- **Password reset mails**: in development they land in `.data/mail/` as JSON
  files containing the reset URL.
