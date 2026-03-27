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

## 2026-03-22 (IST) - Reply persistence review

### New findings

#### 7. Incoming and outgoing message updates are not wrapped in one transaction
- Why it is a problem: The reply pipeline updates the incoming row and outgoing row separately in `src/app.ts`. If the process crashes between those writes, the database can end up with one side marked `processed` while the other side is still `received` or `failed`.
- Where it occurs: `src/app.ts`, `src/db.ts`
- Suggested improvements:
  - Add a transaction helper to the message store so related state changes commit together.
  - Group the final incoming/outgoing status updates into one atomic DB operation.
  - If a transaction is not practical everywhere, keep the outbox/state machine model consistent with retries.

#### 8. Background message updates can overwrite newer state without concurrency checks
- Why it is a problem: `updateMessageSafely(...)` updates rows by ID only. That is fine for the current single-writer flow, but it leaves no protection if retries, multiple workers, or future background jobs try to update the same row out of order.
- Where it occurs: `src/app.ts`, `src/db.ts`
- Suggested improvements:
  - Add a `version` or `updated_at` guard for optimistic concurrency control.
  - Reject stale updates when a newer status has already been written.
  - Revisit this if the app gains multi-worker processing or explicit retry jobs.

#### 9. SQLite writes are synchronous on the main event loop
- Why it is a problem: `better-sqlite3` is synchronous, so every insert and update blocks the Node.js event loop. That is acceptable for low traffic, but it can still add latency to webhook handling and make the server less responsive as load grows.
- Where it occurs: `src/db.ts`, `src/app.ts`
- Suggested improvements:
  - Move database work into a worker thread or background queue if traffic rises.
  - Switch to an async SQLite driver if the request path becomes busier.
  - Keep the current sync approach only if the throughput target stays small.

#### 10. Failed state updates are logged but do not stop the reply flow
- Why it is a problem: `updateMessageSafely(...)` swallows update errors after logging them. That lets the reply pipeline continue, but it can also leave the database in a misleading state if a critical status transition fails.
- Where it occurs: `src/app.ts`
- Suggested improvements:
  - Distinguish between critical and non-critical updates.
  - Stop the background reply flow when the final state transition fails.
  - Surface a recovery path if persistence fails after the user has already been replied to.

### Not a finding

#### 11. Error payload serialization is currently narrow and safe
- Why it is not a problem: `serializeErrorPayload(...)` only stores `name` and `message`, not the full error object. That means circular references and large nested payloads are not part of the current serialization path.
- Where it occurs: `src/app.ts`
- Current status: not logged as an issue for this code path.
