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
