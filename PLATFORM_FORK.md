# Agent Platform fork

This fork adds explicit meeting delivery to James, Arkenza, and Kim through the existing agent-platform `POST <routePrefix>/ingest/company` contract. The first use of each target asks for its HTTPS endpoint and existing ingestion key. James is the platform's `jason` instance; Arkenza keeps the legacy `/fluency` route.

After transcription finishes, open a meeting's More menu → Send to agent → Send to James, Arkenza, or Kim. Review the complete Markdown export before sending. The export includes notes, summaries, meeting metadata, participants, and speaker-labelled transcripts. Audio and attachments are not uploaded. The destination returns an ingestion receipt, not an agent completion acknowledgement. Existing platform chat subscriptions to `meeting.transcript_received` determine the reaction. The recipient can read the entire source using `company_inbox`.

Signing happens in Rust, using `x-company-timestamp` and HMAC-SHA256 of `timestamp + "." + exactRawJson`. Credentials never enter build artifacts or browser storage. Configuration and saved delivery snapshots live under the app's native configuration directory, in `agent-platform/`, with owner-only directory/file permissions on Unix. On Windows they inherit the user's app-directory ACL; managed Windows deployments should enforce that ACL. These files contain sensitive source text and signing credentials; keep them out of sync/backup destinations shared with others.

Delivery IDs hash the exact exported content and target. Repeated sends and lost acknowledgements reuse that ID and the platform's durable ingestion receipt. Edited exports produce a new ID. A preview stores an immutable local snapshot; Retry sends that exact snapshot. Changing the configured destination requires a new preview. No automatic upload occurs. Large exports fail clearly against the platform's existing request limits rather than silently truncating source evidence.

## Desktop privacy changes

- The analytics plugin preserves its caller API as permanent no-ops. It does not enrich payloads, fingerprint devices, identify users, or start a transport. The shared analytics builder also cannot construct a PostHog transport.
- The desktop has no Sentry initialization, replay recorder, or crash reporter transport. Enabling upstream consent preferences cannot restore telemetry.
- The desktop registers neither upstream updater plugin; the updater meeting service is unmounted and updater feeds/artifacts are removed from desktop bundle profiles.
- Webview fetch, XHR, WebSocket and beacon requests to upstream and telemetry service domains are denied. The native HTTP bridge has matching deny scopes. Runtime resource suggestions and remote changelog requests are removed.
- Upstream hosted auth, AI, cloud sync, enterprise API, and static service configuration are ignored in the desktop, even when inherited through build environment files. Native startup has no CloudSync configuration. The distinct `com.stillerman.anarlog` bundle identity avoids inheriting upstream authentication/settings by default.
- Local transcription and local or explicitly selected BYOK AI remain. Model downloads, manually configured AI providers, calendars, webhooks, local APIs, and shell/plugin capabilities remain functional network capabilities. This is not an OS-level network sandbox. No claim of zero egress has been made until a built application passes a runtime network audit.

The mobile source is included from upstream, but this desktop integration does not add agent delivery or certify telemetry removal for mobile. Upstream publishes an iOS TestFlight beta at https://testflight.apple.com/join/y7WJCXvG. A future forked mobile build should use the same ingestion envelope with device-specific revocable credentials.

## Follow-up integration improvements

Use per-device revocable ingestion credentials instead of distributing instance-wide HMAC keys. Add destination chat selection and a link to its platform inbox/receipt. Add a durable outbox list with pending/recorded status and optional retries for explicitly requested sends. Add transcript revision/supersession references so agents can distinguish corrected notes from new meetings. Add optional project and recurring-meeting tags, and an iOS share extension/audio import path.

## Build and verification

Use the upstream locked Node/pnpm/Rust versions and desktop CI checks described in `AGENTS.md`. Verified in this checkout: production frontend build, desktop TypeScript check, 57 focused desktop tests, all 32 local API plugin tests, native analytics tests, and strict local API Clippy. The native desktop checks pass with both `direct-distribution` and `app-store` features. Oxlint and targeted ESLint have no errors; the upstream codebase has existing warnings. Native build prerequisites were resolved using the pinned Rust toolchain, Xcode's Metal Toolchain, temporary CMake, and anonymous public Swift dependency downloads with Keychain lookup disabled. No installer is published by this change. A macOS native build needs Xcode and the Metal toolchain. Test audio capture, permissions, local transcription, delivery against a test platform instance, and network egress on the resulting native app before using it for production recordings.
