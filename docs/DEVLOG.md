# Dev Log

- 2026-03-28 (IST) - One-time Telegram reminders added
  - Added one-time reminder parsing for messages like `remind me to send email in 1 minute` alongside the existing recurring `every N minutes` reminder flow.
  - Extended scheduled task persistence with a `runOnce` flag so one-time reminders are stored durably and disable themselves after the first successful delivery.
  - Added regression coverage for one-time reminder parsing, app-level creation, SQLite persistence, and scheduler auto-disable behavior.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/db.ts`, `src/reminders.ts`, `src/scheduler.ts`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/db.test.ts`, `tests/scheduler.test.ts`, `tests/skill-runner.test.ts`, `README.md`, `config.example.yaml`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` with elevated permissions and all 114 tests passed.

- 2026-03-28 (IST) - Reminder confirmations now read like normal chat replies
  - Updated the Telegram formatter so `reminder_create` replies return a human-friendly confirmation message instead of the generic `success / output / error` wrapper used by developer-oriented skills.
  - Kept the structured formatter unchanged for file and shell skills, and added regression coverage for the reminder-only formatting behavior.
  - Files touched: `src/skills.ts`, `tests/app.test.ts`, `tests/skill-runner.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` limit again; reran `node --test dist/tests/*.test.js` with elevated permissions.

- 2026-03-28 (IST) - Telegram chat reminders with dynamic minute intervals
  - Added direct Telegram reminder creation for phrases like `remind me every 10 minutes to drink water`.
  - Parsed the requested minute interval dynamically, stored the reminder as a scheduled task in SQLite, and updated the same reminder task when the same chat repeats the same reminder text with a new interval.
  - Made chat-created reminders deterministic by encoding them as static scheduled outputs so reminder delivery does not depend on LLM phrasing or blank completions.
  - Files touched: `src/app.ts`, `src/reminders.ts`, `src/scheduler.ts`, `src/skills.ts`, `tests/app.test.ts`, `tests/scheduler.test.ts`, `tests/skill-runner.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` limit again; reran `node --test dist/tests/*.test.js` with elevated permissions and all 110 tests passed.

- 2026-03-28 (IST) - Scheduler empty-output fallback improved
  - Fixed scheduled Telegram reminders so blank model completions no longer send the literal `(no output)` placeholder to chats.
  - Added a readable fallback message when a scheduled task completes with empty text, and added regression coverage for that path.
  - Files touched: `src/scheduler.ts`, `tests/scheduler.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` limit again; reran `node --test dist/tests/*.test.js` with elevated permissions.

- 2026-03-28 (IST) - Scheduler can now send recurring Telegram text messages
  - Extended scheduled task config and SQLite persistence with an optional `telegramChatId`, including a safe migration for existing `scheduled_tasks` tables.
  - Wired the scheduler through the existing Telegram adapter so successful cron runs can send real Telegram text messages and persist those deliveries into the normal `messages` table.
  - Kept the existing log-only scheduler behavior unchanged for tasks that omit `telegramChatId`, and added regression coverage for config parsing, SQLite migration, successful delivery, and delivery failures.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/db.ts`, `src/scheduler.ts`, `tests/config.test.ts`, `tests/db.test.ts`, `tests/scheduler.test.ts`, `config.example.yaml`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` limit again; reran `node --test dist/tests/*.test.js` with elevated permissions and all 105 tests passed.

- 2026-03-27 (IST) - Natural-language fs_read/fs_write mapping
  - Added natural-language parsing so Telegram requests like `Save file name as name.txt content is hi praveen` map to `fs_write`, and requests like `Read file name.txt` map to `fs_read`.
  - Kept explicit slash commands (`/fs_read`, `/fs_write`) unchanged and prioritized them before natural-language matching.
  - Added parser regression tests plus app-level webhook tests to verify natural-language read/write requests execute through the skill runner and bypass the normal LLM path.
  - Files touched: `src/skills.ts`, `tests/skill-runner.test.ts`, `tests/app.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` hit sandbox `spawn EPERM`; reran `node --test dist/tests/*.test.js` with elevated permissions and all 86 tests passed.

- 2026-03-27 (IST) - Week 3 milestone completion
  - Added a worker-thread skill runner with strict time and memory limits, direct Telegram `fs_read` and `fs_write` commands, file-size caps, and a configurable path allowlist plus blocked-path safety checks.
  - Standardized skill results to `success`, `output`, and `error`, then logged every skill call with duration and result size without routing direct skill commands through the normal LLM path.
  - Added regression coverage for the app-level skill path, worker-backed read/write execution, allowlist and blocked-path enforcement, read-limit failures, timeout handling, and the new skill config validation.
  - Updated the config example and README so the new `skills` config block, `SKILLS_*` overrides, and Telegram command syntax are documented.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/skill-runner.ts`, `src/skill-worker.ts`, `src/skills.ts`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/skill-runner.test.ts`, `config.example.yaml`, `README.md`, `docs/DEVLOG.md`, `ISSUES.md`.
  - Verification: `npm run build`; `npm test` initially hit the sandbox `spawn EPERM` limit; reran `node --test dist/tests/*.test.js` with elevated permissions and all 82 tests passed.

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

- 2026-03-12 (IST) - Week 2 milestone completion
  - Added a unified LLM interface with `generate`, `stream`, and `embeddings`, backed by an OpenAI adapter that uses request timeouts, max token limits, and environment-driven model configuration.
  - Added a deterministic planner prompt with strict system/user separation, then used a second streamed LLM call to progressively edit Telegram replies instead of sending a single echo response.
  - Updated the webhook flow to acknowledge Telegram quickly, continue reply generation in the background, and log redacted prompts/completions for debugging.
  - Extended Telegram delivery to support message edits, updated runtime config/docs/docker env passthrough, and added automated coverage for planning, streaming, embeddings, config validation, and the new Telegram behavior.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/db.ts`, `src/llm.ts`, `src/messages.ts`, `src/openai-llm.ts`, `src/planner.ts`, `src/telegram-adapter.ts`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/openai-llm.test.ts`, `tests/planner.test.ts`, `tests/telegram-adapter.test.ts`, `config.example.yaml`, `docker-compose.yml`, `README.md`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - Reply streaming resilience follow-up
  - Fixed the Telegram reply pipeline to use final `completed` stream text when incremental deltas are missing, which prevents empty model responses from collapsing into the generic fallback.
  - Broadened the OpenAI streaming parser to handle snapshot-style text payloads more safely and added a more helpful fallback message for time-sensitive movie recommendation queries.
  - Added regression coverage for completed-only streams, snapshot-style SSE payloads, and local planner heuristics that flag recent entertainment ranking requests as needing a limitation notice.
  - Files touched: `src/app.ts`, `src/openai-llm.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/openai-llm.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - Empty-stream response recovery
  - Added a non-streamed response recovery path so the Telegram bot still returns a real answer when the streaming call completes without text.
  - Relaxed the planner heuristics for entertainment recommendations so prompts like Telugu movie suggestions are treated as normal recommendation requests instead of limitation-first live-data queries.
  - Tightened the response prompt to require a direct answer even when a limitation note is needed, and added regression coverage for the empty-stream recovery flow.
  - Files touched: `src/app.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - GPT-5 response tuning for recommendation prompts
  - Tuned the OpenAI chat request builder to send `reasoning_effort: low` for GPT-5 models, raised the effective response token budget for GPT-5 reply generation, and increased the GPT-5 reply timeout used by the Telegram response path.
  - Simplified the final response system prompt so recommendation requests are answered directly with a concrete shortlist instead of drifting into reasoning-heavy empty completions.
  - Verified the Telugu movie prompt against the real OpenAI setup after the code change, and it returned a visible best-effort movie list instead of an empty response.
  - Files touched: `src/app.ts`, `src/openai-llm.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/openai-llm.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`, `npm test`, manual local OpenAI probe for `suggest me best movies in telugu 2025`.

- 2026-03-13 (IST) - Recommendation quality follow-up
  - Routed GPT-5 recommendation prompts through the higher-quality non-streamed response path instead of the weaker streamed wording path.
  - Tightened the recommendation instructions to prefer exact titles and 4-digit years, omit uncertain entries, avoid speculative placeholders, and stop claiming the bot can fetch live data in this build.
  - Verified the recommendation path still passes the automated suite after the prompt-quality changes.
  - Files touched: `src/app.ts`, `src/planner.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - Telegram placeholder-send recovery
  - Investigated a missed `action` reply and confirmed the incoming message reached the app but the initial Telegram `sendMessage` placeholder failed, which previously aborted the whole response flow.
  - Updated the background reply pipeline so placeholder delivery failures no longer kill the reply; the bot now continues generation and sends the final answer directly if the placeholder could not be posted.
  - Added regression coverage for the failed-placeholder case to ensure the final reply is still delivered and persisted.
  - Files touched: `src/app.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - Telegram final-edit delivery fallback
  - Investigated a later `released in year 2025` failure and found the incoming message reached the app, which points to a reply-delivery failure rather than the webhook itself missing the message.
  - Updated the reply path so failed Telegram message edits no longer abort the reply; when the final edit fails, the bot now falls back to sending the completed answer as a fresh message.
  - Added a delivery-specific fallback message for Telegram-side failures and regression coverage for the failed-final-edit case.
  - Files touched: `src/app.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - Default model switched to GPT-5.1
  - Updated the runtime defaults, Docker fallback environment variable, config example, and test fixtures to use `gpt-5.1` as the default chat model instead of `gpt-5-mini`.
  - Documented the new default in the README and kept `LLM_MODEL` override support for lower-cost alternatives.
  - Files touched: `src/config.ts`, `config.example.yaml`, `docker-compose.yml`, `README.md`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/openai-llm.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-13 (IST) - Accurate Mode live lookup + Best-guess fallback
  - Added a generic `liveLookup` runtime config and an OpenAI web-search-backed lookup client so time-sensitive or year-specific prompts can use live search before the normal chat reply path.
  - Updated the Telegram reply pipeline to try Accurate Mode first, short-circuit on successful live answers, and fall back to Best-guess Mode by explicitly allowing labeled likely-picks from the main model when live lookup is unavailable.
  - Refined recommendation fallback prompts, added coverage for live lookup heuristics and app integration, and updated the README/config examples to document the new Accurate Mode / Best-guess Mode behavior.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/live-lookup.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/live-lookup.test.ts`, `tests/planner.test.ts`, `config.example.yaml`, `docker-compose.yml`, `README.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` worker-process limit; reran `node --test dist/tests/*.test.js` with elevated permissions and all 39 tests passed.

- 2026-03-13 (IST) - Accurate Mode quality gate for verified live data
  - Enabled actual web search on the OpenAI search model request, widened live-lookup triggers to include IMDb/ranking-style prompts, and extracted citations from search annotations when the model returns them.
  - Tightened the live-data behavior so verified requests like weather, current rankings, scores, and prices no longer fall back to vague LLM suggestions; weak or source-less live answers now return a concise fail-closed reply instead of “check Google” guidance.
  - Added regression coverage for fail-closed weather/ranking behavior, weak live-answer rejection, and the stronger live-lookup heuristics, and sanitized the README webhook example token placeholder.
  - Files touched: `src/app.ts`, `src/live-lookup.ts`, `tests/app.test.ts`, `tests/live-lookup.test.ts`, `README.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` worker-process limit; reran `node --test dist/tests/*.test.js` with elevated permissions and all 44 tests passed.

- 2026-03-13 (IST) - Accurate Mode runtime compatibility follow-up
  - Fixed the OpenAI web-search request shape by removing the incompatible `response_format: json_object` when web search is enabled, which was causing live lookup requests to fail before returning any real data.
  - Hardened config loading to strip surrounding quotes from env/config strings so quoted API keys do not get passed to OpenAI as invalid credentials.
  - Relaxed the live-answer acceptance gate to allow strong web-search answers even when the model does not emit citation annotations, which matches the observed OpenAI weather response behavior.
  - Added regression coverage for quoted env values and strong annotation-free live answers, then manually confirmed a live Chennai weather probe returned real data through the corrected search request.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/live-lookup.ts`, `tests/app.test.ts`, `tests/config.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` with elevated permissions, 46/46 passing; manual live OpenAI web-search probe for `tell me the weather of chennai now`.

- 2026-03-13 (IST) - Short follow-up conversation context
  - Added a short recent-conversation window to the planner and reply prompts so follow-up messages like `malayalam` can inherit the previous topic instead of being interpreted as unrelated standalone queries.
  - Wired the app to pull the most recent processed user/assistant turns from SQLite before planning, and added regression coverage for the TV-shows follow-up case.
  - Updated the README note to document that the bot now uses short chat history for follow-up understanding.
  - Files touched: `src/app.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/planner.test.ts`, `README.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` with elevated permissions, 47/47 passing.

- 2026-03-13 (IST) - Recommendation scope tightening
  - Tightened the recommendation system prompt so broad requests stay within the user's requested scope and do not invent extra language, genre, platform, or regional sublists unless the user explicitly asks for that split.
  - Added regression coverage to keep prompts like `best tv shows in india` from drifting into unsolicited Malayalam/regional buckets.
  - Files touched: `src/planner.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` with elevated permissions, 48/48 passing.

- 2026-03-13 (IST) - Strict verified live mode for exact year-specific list queries
  - Tightened Accurate Mode heuristics so exact list-style asks such as year-specific songs, movies, shows, rankings, and similar factual shortlists now require verified live lookup instead of falling back to likely-picks guesses.
  - Added contextual live-lookup triggering for short referential follow-ups like `i want only from 2025`, while limiting the classifier to recent user turns so assistant-generated years do not accidentally force live mode on unrelated follow-ups.
  - Hardened both the live-search and normal planner prompts to omit uncertain supporting metadata such as song-to-film or show-to-platform mappings instead of inventing them.
  - Added regression coverage for strict song-query fail-closed behavior, contextual year-only follow-ups, live-lookup request shaping, and the updated prompt guidance.
  - Files touched: `src/app.ts`, `src/live-lookup.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/live-lookup.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` worker-process limit; reran `node --test dist/tests/*.test.js` with elevated permissions and all 53 tests passed.

- 2026-03-13 (IST) - Retry reuse and Telegram reply cleanup
  - Added retry-aware prompt resolution so short follow-ups like `try again` reuse the most recent real user request instead of being treated as a vague new prompt.
  - Relaxed strict fail-closed behavior for older closed-year recommendation requests such as `best songs from 2021 english`: the bot still attempts live lookup first, but now falls back to internal knowledge when verified live data is unavailable.
  - Sanitized final Telegram replies to strip markdown emphasis, markdown links, raw citation clutter, and `utm_source=openai` URL noise so replies read cleanly in plain-text chats.
  - Tightened prompt instructions so both Accurate Mode and the normal planner avoid markdown-heavy answers and “go check this playlist/site” style detours.
  - Added regression coverage for historical-year fallback behavior, retry reuse, and Telegram-text cleanup.
  - Files touched: `src/app.ts`, `src/live-lookup.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/live-lookup.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`; reran `node --test dist/tests/*.test.js` with elevated permissions and all 55 tests passed.

- 2026-03-14 (IST) - Compact recommendation lists and typo-tolerant platform lookup
  - Added compact recommendation reply shaping so list-style entertainment answers are trimmed down to short Telegram-friendly numbered lists instead of long descriptive paragraphs.
  - Normalized obvious platform typos in recommendation prompts, so inputs like `primw` are corrected to `prime video` before Accurate Mode decides how to search.
  - Tightened both planner and live-lookup prompts to default recommendation answers to short list-only outputs unless the user explicitly asks for details.
  - Added regression coverage for verbose live-answer compaction and typo-normalized platform queries.
  - Files touched: `src/app.ts`, `src/live-lookup.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`; reran `node --test dist/tests/*.test.js` with elevated permissions and all 57 tests passed.

- 2026-03-14 (IST) - Human-readable shortlist formatter for recommendation replies
  - Reworked the final recommendation formatter so list requests now come back as a human-readable shortlist with a compact header and numbered `title - short note` items instead of paragraph blobs.
  - Added year-aware parsing for verbose live-search recommendation answers and a line-based fallback so both live and non-live recommendation paths land in the same Telegram-friendly shape.
  - Files touched: `src/app.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`; reran `node --test dist/tests/*.test.js` with elevated permissions and all 57 tests passed.

- 2026-03-14 (IST) - Default shortlist size increased to 10
  - Changed the recommendation formatter so list-style replies now default to 10 items unless the user explicitly asks for a smaller count.
  - Updated regression coverage for the expanded default list output.
  - Files touched: `src/app.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`; reran `node --test dist/tests/*.test.js` with elevated permissions and all 57 tests passed.

- 2026-03-14 (IST) - Slightly richer one-line recommendation notes
  - Expanded the shortlist note formatter so numbered recommendation replies now keep a little more useful context per item instead of trimming descriptions too aggressively.
  - Updated both the normal planner prompt and Accurate Mode live-lookup prompt to ask for compact numbered lists with brief but informative one-line notes.
  - Added regression coverage to keep the richer note format stable for verbose live recommendation answers.
  - Files touched: `src/app.ts`, `src/planner.ts`, `src/live-lookup.ts`, `tests/app.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 57/57 passing.

- 2026-03-14 (IST) - Evergreen discovery asks no longer fail closed on future-year prompts
  - Refined the strict Accurate Mode classifier so travel/discovery-style recommendation requests such as places to visit can still fall back to a normal shortlist when live lookup is unavailable, even if the prompt mentions a recent or future year.
  - Kept strict fail-closed behavior for genuinely volatile exact/live queries such as weather, rankings, and year-specific entertainment release lists.
  - Added regression coverage for both the classifier rule and the Telegram webhook fallback path for `best places to visit in rajasthan in 2026`.
  - Files touched: `src/live-lookup.ts`, `tests/live-lookup.test.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 58/58 passing.

- 2026-03-27 (IST) - Added a code flow diagram image to the project
  - Added a new PNG diagram at `docs/code-flow.png` that shows the high-level startup, webhook, live lookup, LLM, reply, and SQLite update flow.
  - Kept the SVG source at `docs/code-flow.svg` and switched the README embed to the PNG so the project exposes a normal image file.
  - Files touched: `README.md`, `docs/code-flow.png`, `docs/DEVLOG.md`.
  - Verification: docs-only change; no build or test run needed.

- 2026-03-14 (IST) - Concise final replies for Telegram
  - Added a final reply-shaping layer so verbose non-list answers are compacted into short human-readable Telegram replies, while structured shortlists keep their numbered format.
  - Tightened both the normal planner prompt and Accurate Mode live-lookup prompt to prefer 1-2 short sentences for non-list answers and avoid extended forecast/background dumps unless the user explicitly asks for them.
  - Improved inline numbered recommendation parsing so compact fallback responses can still become clean numbered shortlists even when the upstream text is returned on one line.
  - Added regression coverage for verbose live factual answers and the empty-stream recovery path under the new concise formatting rules.
  - Files touched: `src/app.ts`, `src/planner.ts`, `src/live-lookup.ts`, `tests/app.test.ts`, `tests/planner.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 59/59 passing.

- 2026-03-14 (IST) - Generic alias-based recommendation normalization
  - Replaced platform-specific rewrite chains in recommendation prompt normalization with a shared alias-sequence matcher so normalization stays data-driven instead of hardcoded in the code path.
  - Reused the same alias-based detection for recommendation headers so the prompt-normalization and display logic stay consistent.
  - Files touched: `src/app.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 59/59 passing.

- 2026-03-14 (IST) - Stronger verified shortlist handling for catalog/ranking requests
  - Broadened recommendation-query detection so catalog-style asks like `best korean dramas in thriller genre based on imdb` are treated as shortlist requests instead of raw free-form text.
  - Tightened verified live-list acceptance so strict ranking/catalog requests no longer accept a one-item partial answer as good enough; the bot now retries once with a stronger numbered-list instruction before failing closed.
  - Improved recommendation parsing to prefer line-based extraction when the live answer already looks like a numbered list.
  - Added regression coverage for broader catalog detection and the insufficient-live-list retry path.
  - Files touched: `src/planner.ts`, `src/app.ts`, `tests/planner.test.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 61/61 passing.

- 2026-03-14 (IST) - Source-aware retry for verified live shortlist requests
  - Strengthened the second-pass live retry prompt so when a user asks for results based on a named source or ranking system, the retry explicitly allows reputable current pages that cite that source if direct access is thin.
  - Kept the retry generic by deriving the source context from the user's wording instead of hardcoding source-specific branches.
  - Added regression coverage to ensure the retry request includes the generic source-citation instruction for source-based ranking asks.
  - Files touched: `src/app.ts`, `src/live-lookup.ts`, `tests/app.test.ts`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 61/61 passing.

- 2026-03-14 (IST) - Cleaner numbered shortlist parsing for live recommendation answers
  - Improved the generic shortlist parser so numbered live answers keep their brief notes, skip intro sentences, and handle inline markdown plus dash variants without collapsing into a single malformed item.
  - Added a generic cleanup step that strips trailing wrap-up summary sentences from the last recommendation line so Telegram replies stay concise and item-focused.
  - Added regression coverage for numbered live recommendation answers with inline markdown and retained the concise language-specific shortlist behavior.
  - Files touched: `src/app.ts`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 63/63 passing; live OpenAI/search probe confirmed the Korean and Japanese IMDb-style prompts now return numbered shortlists instead of the fail-closed error.

- 2026-03-14 (IST) - Future-year course recommendations no longer fail closed
  - Narrowed the strict Accurate Mode classifier so a future year by itself only forces fail-closed behavior for genuinely time-bound release catalogs, not broader recommendation asks like courses.
  - Expanded the structured recommendation detector to cover generic course/product-style shortlist queries without incorrectly treating general advice prompts as recommendations.
  - Added regression coverage for `best ai courses to learn in 2026` in both the live-lookup classifier and the Telegram webhook fallback path.
  - Files touched: `src/live-lookup.ts`, `src/planner.ts`, `tests/live-lookup.test.ts`, `tests/planner.test.ts`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 64/64 passing; live OpenAI/search probe confirmed `best ai courses to learn in 2026` now returns a numbered shortlist instead of the fail-closed error.

- 2026-03-14 (IST) - Compact multi-part recommendation replies stay complete
  - Stopped flattening multi-part recommendation requests into a single shortlist by detecting generic multi-step asks and preserving each requested part in order.
  - Normalized inline numbered live answers into real line breaks, stripped bare source-style parentheticals, and added compact transition breaks so mixed recommendation replies stay readable in Telegram.
  - Narrowed fail-closed behavior to true real-time fact domains only, while still retrying weak structured live answers once before falling back.
  - Added regression coverage for multi-part recommendation replies, year-only follow-ups, and the updated retry behavior.
  - Files touched: `src/app.ts`, `src/live-lookup.ts`, `src/planner.ts`, `tests/app.test.ts`, `tests/live-lookup.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 65/65 passing; live OpenAI/search probe confirmed the Telugu-thriller-plus-90s follow-up prompt now returns a compact two-part reply instead of dropping the later request.

- 2026-03-14 (IST) - Short numeric follow-ups now preserve exact values
  - Added a shared generic numeric-refinement detector so short follow-ups like `2000`, `under 2000`, or `2 adults` are treated as refinements of the recent request instead of vague standalone prompts.
  - Updated the planner, response, and live-lookup prompt builders to explicitly preserve every digit exactly as written and avoid paraphrasing or swapping in nearby values.
  - Added regression coverage for the shared detector plus planner/live-lookup prompt generation so short numeric follow-ups keep their exact numbers.
  - Files touched: `src/request-shape.ts`, `src/planner.ts`, `src/live-lookup.ts`, `tests/request-shape.test.ts`, `tests/planner.test.ts`, `tests/live-lookup.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions, 70/70 passing.

- 2026-03-14 (IST) - Default chat model switched back to GPT-5 mini
  - Updated the runtime default model, config example, Docker fallback environment variable, README note, and test fixtures to use `gpt-5-mini` as the default chat model again.
  - Left model overrides intact so `LLM_MODEL` can still point to a different model when needed.
  - Files touched: `src/config.ts`, `config.example.yaml`, `docker-compose.yml`, `README.md`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/openai-llm.test.ts`, `tests/planner.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `node --test dist/tests/*.test.js` initially failed in the sandbox with `spawn EPERM`, then passed with elevated permissions.

- 2026-03-14 (IST) - Junior-friendly internal architecture notes updated
  - Rewrote `docs/my own understanding` into a proper internal handoff document explaining the current architecture, request pipeline, live lookup vs fallback behavior, recent fixes, debugging guidance, and testing workflow in junior-friendly language.
  - Included the major behavior improvements from the recent Telegram reply-shaping and follow-up-handling work so a new developer can understand the system without reading the entire commit history first.
  - Files touched: `docs/my own understanding`, `docs/DEVLOG.md`.
  - Verification: docs-only update; no build or test run needed.

- 2026-03-14 (IST) - Internal notes file ignored from git
  - Added `docs/my own understanding` to `.gitignore` so the junior-friendly handoff notes stay local and do not show up as a tracked repo change by default.
  - Files touched: `.gitignore`, `docs/DEVLOG.md`.
  - Verification: repo-hygiene update only; no build or test run needed.

- 2026-03-22 (IST) - Movie-title metadata questions now trigger Accurate Mode
  - Fixed the live-lookup classifier so factual entertainment-title questions such as `is sentimental value a norwegian movie?` and short follow-ups like `then which language movie is this?` are treated as lookup-worthy metadata requests instead of plain chat completions.
  - Added regression coverage in both the live-lookup unit tests and the Telegram webhook integration suite to confirm short follow-ups reuse recent title context and stay on the live-lookup path.
  - Files touched: `src/live-lookup.ts`, `tests/live-lookup.test.ts`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` hit the sandbox `spawn EPERM` limit; reran `node --test dist/tests/*.test.js` with elevated permissions and all 72 tests passed.

- 2026-03-28 (IST) - Week 4 shell_exec milestone completed
  - Added guarded `shell_exec` support to the skill system with a strict exact-command allowlist, blocked dangerous executables and interpreter-eval patterns, capped shell output, and execution inside a configured working directory.
  - Added a red-team regex filter for risky shell prompts, manual confirmation for mutating allowlisted commands, and durable SQLite audit logging for shell requests through `tool_audit_logs`.
  - Extended the Telegram webhook flow so `/shell_exec`, `run command ...`, `/confirm_shell`, and `/cancel_shell` work as direct skill/control requests without touching the normal LLM reply path.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/db.ts`, `src/shell-policy.ts`, `src/shell-executor.ts`, `src/skill-runner.ts`, `src/skill-worker.ts`, `src/skills.ts`, `tests/app.test.ts`, `tests/config.test.ts`, `tests/db.test.ts`, `tests/shell-policy.test.ts`, `tests/skill-runner.test.ts`.
  - Verification: `npm run build`; `npm test` required elevated execution outside the sandbox because Node test worker spawning hit `spawn EPERM`, then all 100 tests passed.

- 2026-03-28 (IST) - Week 5 developer workflow milestone completed
  - Added a clearer CLI workflow with `npm run dev` watch mode, `npm run lint`, `npm run check`, and `npm run reset-db`.
  - Added a dedicated reset-db helper script that only deletes the configured SQLite database inside the workspace.
  - Expanded happy-path integration coverage and added a GitHub Actions CI workflow that runs `npm ci`, `npm run lint`, and `npm test`.
  - Rewrote the README around the current feature set and setup flow.
  - Files touched: `package.json`, `scripts/reset-db.ts`, `.github/workflows/ci.yml`, `README.md`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` required elevated execution outside the sandbox because Node test worker spawning hit `spawn EPERM`, then all 100 tests passed.

- 2026-03-28 (IST) - Week 6 Ollama, scheduler, and viewer milestone completed
  - Added an Ollama LLM adapter plus provider toggle so the main reply path can switch between OpenAI and Ollama from config.
  - Added cron-style scheduled tasks stored in SQLite with run history, duration/error tracking, overlap prevention through task locks, and background rate limiting.
  - Added a minimal web log viewer at `/logs` with an accompanying JSON endpoint showing scheduled tasks, recent task runs, and recent tool audits.
  - Updated config loading, config examples, and Docker defaults to account for the new provider, scheduler, viewer, and shell settings safely.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/cron.ts`, `src/db.ts`, `src/llm-factory.ts`, `src/ollama-llm.ts`, `src/scheduler.ts`, `config.example.yaml`, `docker-compose.yml`, `README.md`, `tests/ollama-llm.test.ts`, `tests/scheduler.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build`; `npm test` required elevated execution outside the sandbox because Node test worker spawning hit `spawn EPERM`, then all 100 tests passed.

- 2026-03-28 (IST) - Docker shell sandbox enabled safely
  - Updated Docker Compose so shell execution is enabled inside the container without opening it broadly.
  - Added a dedicated repo mount at `/app/workspace`, kept `/app/clawallowed` for file skills, pinned shell execution to `/app/workspace`, and restricted the Docker shell allowlist to `git status --short`, `npm run lint`, and `npm run build`.
  - Added Docker-specific blocked paths for `.env`, `config.yaml`, `.git`, `node_modules`, and `dist` inside the mounted workspace, and updated the README Docker notes to match the new container paths.
  - Files touched: `docker-compose.yml`, `README.md`, `docs/DEVLOG.md`.
  - Verification: config/docs-only change; no additional build or test run required after the previously passing 100-test baseline.

- 2026-03-28 (IST) - Docker shell commands fixed for git and lint/build
  - Installed `git` in the Alpine app image so the Docker shell allowlist command `git status --short` can run inside the container.
  - Added a Docker entrypoint that seeds `/app/workspace/node_modules` from the image's Linux dependencies, plus a dedicated `workspace_node_modules` volume so Docker shell commands do not depend on the host Windows `node_modules`.
  - Raised the Docker skill timeout to `15000ms` so `npm run lint` and `npm run build` have enough time to complete through the shell skill.
  - Updated Docker notes to explain the Linux-compatible workspace dependency volume and the higher shell timeout.
  - Files touched: `Dockerfile`, `docker-compose.yml`, `scripts/docker-entrypoint.sh`, `README.md`, `docs/DEVLOG.md`.
  - Verification: Docker-specific patch prepared; rebuild the containers with `docker compose --env-file .env up --build` before retesting Telegram shell commands.

- 2026-03-28 (IST) - Chat reminders now support exact clock times
  - Added direct parsing for exact-time reminder phrases like `remind me at 2pm to send email`, `remind me to send email at 2pm`, and `remind me tomorrow at 9:15am to join standup`.
  - Updated the reminder creation path so one-time reminders use exact `runAt` timestamps instead of pretending every one-time reminder is still a minute interval.
  - Added parser coverage for same-day, next-day rollover, and explicit tomorrow reminders, plus an app-level Telegram webhook test for `at 2pm`.
  - Files touched: `src/reminders.ts`, `src/app.ts`, `tests/skill-runner.test.ts`, `tests/app.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `node --test dist/tests/*.test.js` passed `116/116` after elevated execution because the desktop sandbox blocked Node test worker spawning with `spawn EPERM`.

- 2026-03-28 (IST) - Docker reminder timezone fix
  - Identified that Docker was running in UTC, so exact-time reminders like `remind me at 2:25pm` were being stored as UTC clock times instead of local time.
  - Added `TZ=${TZ:-Asia/Calcutta}` to the app service in `docker-compose.yml` so container-based clock-time reminders and their confirmation messages align with local time.
  - Updated the README Docker notes to explain how clock-time reminders behave in Docker and how to override the timezone through `.env`.
  - Files touched: `docker-compose.yml`, `README.md`, `docs/DEVLOG.md`.
  - Verification: config/docs-only Docker fix; no TypeScript build or test changes were required.

- 2026-03-28 (IST) - Reminder management and typo-tolerant reminder parsing
  - Added real reminder management commands for `list my reminders`, `list the remainders`, `cancel reminder <text>`, and `/cancel_reminder <id>`.
  - Scoped reminder listing and cancellation to the current Telegram chat so chat users can only manage their own reminder tasks.
  - Expanded reminder parsing to accept `set a reminder ...`, the common typo `set a remainder ...`, and clock times with suffixes like `IST`, preventing those messages from falling through to the normal LLM path.
  - Added parser and app-level webhook coverage for the new reminder management commands and typo-tolerant reminder creation flow.
  - Files touched: `src/reminders.ts`, `src/skills.ts`, `src/app.ts`, `tests/skill-runner.test.ts`, `tests/app.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `node --test dist/tests/*.test.js` passed `119/119` after elevated execution because the desktop sandbox blocked Node test worker spawning with `spawn EPERM`.

- 2026-03-28 (IST) - Exact-date reminder support
  - Added calendar-date parsing for one-time reminders like `remind me on 31 March at 2pm to send email` and `remind me to pay rent on 5 April 2099 at 9am`.
  - When the year is omitted and the requested date has already passed this year, the reminder now rolls forward to the next year instead of being scheduled in the past.
  - Added parser coverage for same-year, next-year rollover, and explicit-year dates, plus an app-level Telegram webhook test for an exact-date reminder.
  - Files touched: `src/reminders.ts`, `tests/skill-runner.test.ts`, `tests/app.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `node --test dist/tests/*.test.js` passed `120/120` after elevated execution because the desktop sandbox blocked Node test worker spawning with `spawn EPERM`.

- 2026-03-28 (IST) - Planner token-limit recovery for short chats
  - Diagnosed Telegram reply failures for simple prompts like `hi` as planner-stage OpenAI truncation errors caused by the planner token budget being too low.
  - Added a planner retry path that automatically retries with a larger token budget when OpenAI reports `max_tokens` or model-output-limit truncation.
  - Raised the Docker default `LLM_PLANNER_MAX_RESPONSE_TOKENS` to `240` so container deployments are less likely to hit the planner limit on short chats.
  - Added planner test coverage for the retry behavior and updated the Docker notes to document the higher planner budget.
  - Files touched: `src/planner.ts`, `tests/planner.test.ts`, `docker-compose.yml`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `node --test dist/tests/*.test.js` passed `121/121` after elevated execution because the desktop sandbox blocked Node test worker spawning with `spawn EPERM`.

- 2026-03-28 (IST) - Reminder parser accepts `set the remainder ...`
  - Fixed a phrasing gap where `set the remainder at 2:54pm ...` was falling through to the normal chat model instead of creating a real reminder task.
  - Expanded the reminder-command normalization so both `set a ...` and `set the ...` forms map into the reminder parser.
  - Added parser and webhook coverage for the exact phrase family so `set the remainder ...` creates a scheduler task instead of a misleading conversational reply.
  - Files touched: `src/reminders.ts`, `tests/skill-runner.test.ts`, `tests/app.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `node --test dist/tests/*.test.js` passed `122/122` after elevated execution because the desktop sandbox blocked Node test worker spawning with `spawn EPERM`.

- 2026-03-28 (IST) - Recurring reminders accept `to ... every N minutes`
  - Added recurring reminder parsing for phrases like `set a remainder to drink water every 2 minutes` and `remind me to stretch every 5 minutes`.
  - This closes the gap where those messages were falling through to the normal chat model instead of creating real recurring reminder tasks.
  - Added parser coverage and an app-level Telegram webhook test for the recurring `to ... every N minutes` phrasing.
  - Files touched: `src/reminders.ts`, `tests/skill-runner.test.ts`, `tests/app.test.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `node --test dist/tests/*.test.js` passed `123/123` after elevated execution because the desktop sandbox blocked Node test worker spawning with `spawn EPERM`.

- 2026-03-28 (IST) - One-command Docker redeploy plus Telegram webhook refresh
  - Added a reusable redeploy helper module for parsing `.env`, extracting the latest Cloudflare quick-tunnel URL from Docker logs, and building the final Telegram webhook URL safely.
  - Added `scripts/redeploy-telegram.ts` plus `npm run redeploy:telegram` so the repo can stop Docker, rebuild the stack, wait for the new tunnel URL, and call Telegram `setWebhook` in one step without printing the bot token.
  - Added webhook retry handling for the quick-tunnel DNS propagation window so redeploys do not fail just because the new `trycloudflare.com` hostname is not immediately resolvable.
  - Added focused unit tests for env parsing, tunnel URL extraction, and webhook retry classification helpers, and documented the retry behavior in the README.
  - Files touched: `src/redeploy.ts`, `scripts/redeploy-telegram.ts`, `tests/redeploy.test.ts`, `package.json`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `npm test` passed with `128/128`.

- 2026-03-28 (IST) - Added standalone webhook refresh command for 2-step Docker workflow
  - Added `scripts/webhook-update.ts` and `npm run webhook:update` so webhook updates can be run independently after `docker compose down` and `up --build -d`.
  - Reused existing safe behavior: token from `.env`, tunnel URL from Docker logs, fixed `/telegram/webhook` suffix via config path, and retry handling for temporary tunnel DNS propagation lag.
  - Updated README with the explicit 2-step command sequence.
  - Files touched: `scripts/webhook-update.ts`, `package.json`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. Runtime check passed with `docker compose --env-file .env down`, `docker compose --env-file .env up --build -d`, and `npm run webhook:update`.

- 2026-03-28 (IST) - Split redeploy and webhook responsibilities
  - Updated `npm run redeploy:telegram` to only perform Docker restart flow (`down` then `up --build -d`) and not attempt webhook updates.
  - Kept `npm run webhook:update` as the dedicated webhook refresh command (token from `.env`, tunnel URL from logs, fixed webhook path suffix).
  - Updated README command descriptions so the two-step workflow is explicit and predictable.
  - Files touched: `scripts/redeploy-telegram.ts`, `README.md`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed.

- 2026-03-28 (IST) - Reduced aggressive truncation for latest-news replies
  - Added a dedicated news-intent branch in Telegram reply compaction so `latest news` style prompts preserve more content instead of being clipped to the generic short limit.
  - Kept existing concise behavior for weather and general prompts, while raising the cap only for news-like requests.
  - Added an app integration test to verify latest-news replies keep key sections and are not aggressively truncated.
  - Files touched: `src/app.ts`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm run build` passed. `npm test` passed with `129/129`.

- 2026-03-28 (IST) - Latest-news replies now render as readable point-wise bullets
  - Added a compact news formatter that converts long news paragraphs into a short heading plus bullet points for each update.
  - Preserved category sections as bullets so replies like `latest news in india today` are easier to scan in Telegram.
  - Updated the latest-news integration test to assert bullet-point formatting.
  - Files touched: `src/app.ts`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm test` passed with `129/129`.

- 2026-03-28 (IST) - Fixed false fail-closed live-lookup behavior after latest-news timeouts
  - Root cause: follow-up processing could push benign messages like `hi` through the verified-live-data path after a previous latest-news timeout.
  - Fix: restored prompt-resolution flow for live lookup (so typo normalization and `try again` behavior stay intact) and added a greeting bypass so plain greetings do not trigger verified-live-data fail-closed responses.
  - Added regression coverage for `hi` after a timed-out latest-news request.
  - Files touched: `src/app.ts`, `tests/app.test.ts`, `docs/DEVLOG.md`.
  - Verification: `npm test` passed with `130/130`.
