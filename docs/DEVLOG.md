# Dev Log

- 2026-03-10 (IST) - Week 1 milestone completion
  - Confirmed end-to-end Telegram echo via Cloudflare quick tunnel using webhook path `/telegram/webhook` and optional secret token.
  - No code changes; operational verification only. Verified by sending Telegram client messages and observing echo responses.
  - Files touched: none. Verification: manual Telegram echo through tunnel URL.

- 2026-03-12 (IST) - Telegram webhook hardening
  - Added configurable Telegram webhook rate limiting, message sanitization before storage, explicit database write guards, richer message lifecycle tracking, and SQLite indexes for message history lookups.
  - Expanded persisted message metadata to include `user_id`, Telegram message timestamps, and status values (`received`, `processed`, `failed`) for both incoming and outgoing records.
  - Updated docs/config examples and added automated coverage for webhook validation, rate limiting, sanitization, schema migration, and persistence failures.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/db.ts`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/db.test.ts`, `config.example.yaml`, `README.md`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-12 (IST) - Unified message adapter refactor
  - Introduced a transport-neutral `UnifiedMessage` contract and `MessageAdapter` interface so the Fastify app can process normalized messages instead of Telegram-specific payload shapes.
  - Added `TelegramAdapter` to isolate Telegram webhook verification, update parsing, message sanitization, and reply delivery behind the new adapter boundary.
  - Added adapter-focused tests and kept the existing webhook behavior green through the app integration suite.
  - Files touched: `src/app.ts`, `src/messages.ts`, `src/telegram-adapter.ts`, `tests/telegram-adapter.test.ts`, `README.md`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-12 (IST) - SQLite Docker journal-mode fallback
  - Changed SQLite startup to prefer WAL mode but fall back to `DELETE` journal mode when the host filesystem cannot open WAL shared-memory files, which fixes container startup on some Docker Desktop and synced-folder mounts.
  - Removed the obsolete Docker Compose `version` key to avoid the current warning in modern Compose.
  - Added regression coverage for the WAL fallback path and documented the runtime behavior in the README.
  - Files touched: `src/db.ts`, `tests/db.test.ts`, `docker-compose.yml`, `README.md`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-12 (IST) - SQLite fallback follow-up fix
  - Fixed the Docker fallback path to stop issuing a second journal-mode pragma after WAL failure, which was re-triggering the same `SQLITE_IOERR_SHMOPEN` crash on bind-mounted storage.
  - Tightened the regression test to ensure the fallback now logs the WAL issue and continues without another journal-mode switch.
  - Files touched: `src/db.ts`, `tests/db.test.ts`.
  - Verification: `npm run build`, `npm test`.
