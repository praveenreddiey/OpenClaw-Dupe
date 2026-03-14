# Issues Review

This file records post-milestone code review findings and suggested fixes.

## 2026-03-08 (IST) - Week 1 Review

### Resolved in follow-up patch

#### 1. Outbound Telegram calls had no timeout or clear delivery failure handling
- Why it was a problem: A slow or hung Telegram API call could keep the webhook request open, increase latency, and trigger duplicate webhook retries. Failures also surfaced as a generic 500 instead of a delivery-specific response.
- Where it occurred: `src/app.ts`
- Fix applied:
  - Added `telegram.requestTimeoutMs` to config.
  - Added `AbortSignal.timeout(...)` to outbound Telegram requests.
  - Added `TelegramDeliveryError` so delivery failures return a specific 502 or 504 error.
- Current status: resolved on 2026-03-08.

#### 2. Missing bot token was treated as a soft success instead of a startup failure
- Why it was a problem: The app could accept webhook traffic and write inbound rows even when it was incapable of replying, which hid broken setup.
- Where it occurred: `src/config.ts`, `src/server.ts`, `src/app.ts`
- Fix applied:
  - Added `validateRuntimeConfig(...)`.
  - Startup now fails fast when `telegram.botToken` is missing or timeout config is invalid.
- Current status: resolved on 2026-03-08.

### Still open

#### 3. Webhook processing is not idempotent and can duplicate messages
- Why it is a problem: Telegram retries webhook delivery when a request fails or times out. The current flow inserts the incoming row before the outbound send completes, so a retry can create duplicate database rows and duplicate replies.
- Where it occurs: `src/app.ts`, `src/db.ts`
- Suggested improvements:
  - Persist `update_id` or Telegram `message_id` with a unique constraint.
  - Track processing state so retries can return success without re-sending the same reply.
  - Consider an outbox table or a transaction-backed state machine for inbound and outbound message handling.

#### 4. SQLite access blocks the Node event loop
- Why it is a problem: `better-sqlite3` is synchronous. Every webhook request currently performs multiple blocking database operations on the main thread, which can serialize concurrent traffic and increase response latency under load.
- Where it occurs: `src/db.ts`, `src/app.ts`
- Suggested improvements:
  - Move SQLite work behind a worker thread or queue.
  - Switch to an async driver if the request path becomes busier.
  - Avoid the extra read-after-insert query when the inserted row is not immediately needed.

#### 5. Full Telegram payloads are stored unbounded in the main messages table
- Why it is a problem: Raw request and response payloads grow the database quickly, increase I/O, and mix audit concerns with the hot message table. They can also capture unnecessary user metadata.
- Where it occurs: `src/app.ts`, `src/db.ts`
- Suggested improvements:
  - Store only the fields needed for normal operations in `messages`.
  - Move raw payload capture into a separate audit table with retention rules.
  - Truncate or compress large payloads if full payload storage is required.

## 2026-03-10 (IST) - Week 1 completion review

- Reviewed codebase after milestone sign-off; no new commits since 2026-03-08 reliability follow-up.
- Findings: no additional issues identified; existing open items (#3–#5 from 2026-03-08 review) remain and should be addressed next.
- Tests: not re-run (no code changes).

## 2026-03-12 (IST) - Week 2 completion review

### New findings

#### 6. Background reply jobs are not durable across process restarts
- Why it is a problem: The webhook now acknowledges Telegram quickly and finishes planning/streaming in the background. If the process restarts after the HTTP 200 but before the placeholder or final edit is delivered, Telegram will not retry and the user can be left without a reply.
- Where it occurs: `src/app.ts`
- Suggested improvements:
  - Persist pending reply jobs in SQLite before returning 200.
  - Add a small outbox/worker loop so unfinished jobs can resume after restart.
  - Mark reply attempts with retryable vs terminal failure states.

### Existing open items still relevant

- Items #3, #4, and #5 remain open after the Week 2 implementation.
- Tests reviewed for this milestone: `npm run build`, `npm test`.
