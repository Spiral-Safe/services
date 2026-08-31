# Annotated Playwright recordings

This recorder creates repeatable product walkthroughs for four surfaces:

1. the actual unpacked Manifest V3 extension and its actual Wallet Standard demo;
2. the actual standalone wallet page in `public/`;
3. the developer dashboard;
4. the admin dashboard.

Every capture is explicitly marked **FIXTURE MODE · SYNTHETIC LOCAL DATA**. The
loopback fixture replaces Vault, Stripe, cloud infrastructure, Solana RPC, and
physical passkeys. It contains a deterministic test-only wallet and accepts
only fake local credentials. It must not be treated as a security, hardware,
billing, or capacity test.

## What is real and what is simulated

| Flow                | Product code exercised                                                                                                        | Deterministic substitute                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Extension demo      | Built extension popup, main-world provider, content script, service worker, Wallet Standard demo, and browser WebAuthn calls  | Loopback signing API, Solana RPC, deterministic test wallet, and CDP virtual authenticator |
| Standalone wallet   | Built `public/browser.js`, `public/index.js`, page controls, request serialization, and browser WebAuthn calls                | Loopback signing API and CDP virtual authenticator                                         |
| Developer dashboard | Built `createApp`; actual `/developer/login` and `/developer` routes; session, role, CSRF, console HTML, and console CSS      | In-memory demo account, masked key alias, seeded usage, fake Vault, and disabled Stripe    |
| Admin dashboard     | Built `createApp`; actual `/admin/login` and `/admin` routes; session, role, account selection, console HTML, and console CSS | In-memory demo tenants, seeded usage/outbox state, fake Vault, and disabled Stripe         |

The recorder blocks non-loopback page traffic. The extension is configured only
with the fixture origin and the literal fake marker `fixture-not-a-secret`.
Neither environment variables nor production configuration provide a token to
the runner. Password inputs and elements marked `data-recording-secret` are
visually redacted. Traces can still contain public DOM/source snapshots, so
review artifacts before sharing them outside the project.

## Run it

Use Node 22 or newer and install both repositories first:

```sh
cd services
npm ci
cd ../extension
npm ci
cd ../services
```

Then run the recorder tests or one of the capture commands:

```sh
npm run recording:test
npm run recording:extension
npm run recording:wallet
npm run recording:dashboards
npm run recording:all
```

The extension flow is always headed because Chromium does not load unpacked
extensions in the ordinary headless context. Other flows accept `--headless`.
The browser lookup order is `--browser`, `SPIRAL_RECORDING_BROWSER`, the pinned
Playwright Chromium, then known locally installed Chromium-family browsers.

Useful direct options:

```sh
node recording/record.mjs --flow standalone-wallet --run-id review-wallet
node recording/record.mjs --flow developer-dashboard,admin-dashboard --headless
node recording/record.mjs --flow all --hold-ms 1200 --settle-ms 800
```

`--skip-build` reuses the current client and extension bundles. `--no-video`
keeps traces, screenshots, and timelines without creating WebM. The capture
pipeline writes native Playwright `.webm` files and does not require MP4
conversion.

## Output contract

Generated files live under `recording/output/<run-id>/` and are ignored by Git:

```text
manifest.json
extension-demo/
  recording.webm
  trace.zip
  timeline.json
  screenshots/01-configure.png ...
standalone-wallet/
developer-dashboard/
admin-dashboard/
```

The root manifest records browser, fixture, status, source, duration, and
artifact paths. Each timeline records the numbered section/title/description,
matched selector, screenshot, relative start, and action duration for every
step. `recording/manifest.json` is the reviewable source timeline. Open a trace
with:

```sh
npx playwright show-trace recording/output/<run-id>/<flow>/trace.zip
```

The reusable overlay in `annotation.mjs` highlights the action target and shows
the numbered section, title, and description before the action. A fixture badge
remains visible through every annotated page segment.

The capture browser uses Playwright's `bypassCSP` option solely so it can inject
that review overlay into the real pages without weakening their checked-in
policies. Before any bypass-enabled browser context starts, a raw loopback
preflight asserts the login response's restrictive CSP,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin`. The real
authenticated document response is checked again during the flow, and both the
root manifest and timeline record the assertions. The artifacts are still not
a browser-enforcement test for those headers.

## Dashboard runtime and selector contract

The dashboard command first compiles `src/`, then starts a recording-only
loopback server around the built `dist/app.js`. It creates the normal in-memory
billing runtime with demo seeding, injects a fake Vault client that refuses
wallet routes, leaves Stripe and Metronome disabled, and logs in through the
actual role-specific forms. The checked-in pages expose these stable hooks so
presentation copy and layout can change without breaking the timeline:

```text
developer-overview      developer-api-keys
developer-create-key    developer-usage
admin-overview          admin-tenants
admin-select-tenant     admin-audit
```

Attach each value as `data-recording="..."`. The developer flow fills a draft
name and user scope but deliberately does not submit the create-key form; no API
key plaintext enters a video, screenshot, or timeline. The static pages in
`recording/fixtures/` remain deterministic unit-test fallbacks and are not used
by the normal dashboard recording command.

## Authenticator boundary

The extension and wallet flows use Chrome DevTools Protocol to add a CTAP2
platform authenticator with resident-key and user-verification support. This
drives real `navigator.credentials.create` and `navigator.credentials.get`
calls, but it does not test Touch ID, Windows Hello, passkey synchronization,
security keys, or authenticator prompts. Keep the repository's manual physical
authenticator release checklist separate.
