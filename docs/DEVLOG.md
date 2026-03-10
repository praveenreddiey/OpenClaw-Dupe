# Dev Log

- 2026-03-08 (IST) - Week 0 scaffold
  - Added the Node and TypeScript project setup, Fastify server, config loader, repo docs, and AGENTS rules.
  - Files touched: `package.json`, `tsconfig.json`, `src/server.ts`, `src/config.ts`, `.gitignore`, `README.md`, `AGENTS.md`, `docs/FILES.md`.
  - Verification: `npm run build`.

- 2026-03-08 (IST) - Week 1 Telegram webhook, SQLite message model, pino logging
  - Added a Fastify app factory, Telegram webhook route, echo behavior, SQLite message store, structured request logging, and compiled test coverage.
  - Files touched: `package.json`, `tsconfig.json`, `config.example.yaml`, `config.yaml`, `src/config.ts`, `src/db.ts`, `src/app.ts`, `src/server.ts`, `tests/app.test.ts`, `tests/db.test.ts`, `README.md`, `docs/FILES.md`.
  - Verification: `npm run build`, `npm test`.

- 2026-03-08 (IST) - Week 1 review workflow and issue log
  - Added a standing review requirement to `AGENTS.md` and documented the current Week 1 findings in `ISSUES.md`.
  - Files touched: `AGENTS.md`, `ISSUES.md`, `docs/FILES.md`.
  - Verification: documentation update only; no code changes to retest.

- 2026-03-08 (IST) - Week 1 reliability follow-up
  - Fixed immediate reliability items from the Week 1 review: Telegram request timeout, startup config validation, and clearer webhook delivery failure responses.
  - Files touched: `src/app.ts`, `src/config.ts`, `src/server.ts`, `config.example.yaml`, `config.yaml`, `tests/app.test.ts`, `tests/config.test.ts`, `README.md`, `ISSUES.md`, `docs/FILES.md`.
  - Verification: `npm run build`, `npm test`.

Pending roadmap
- Week 2: LLM adapter (streaming OpenAI), simple planner prompt, SSE to Telegram replies.
- Week 3: Skill runner in worker threads with time and memory limits, `fs_read`, `fs_write`, path allowlist.
- Week 4: `shell_exec` skill with command allowlist and output cap, audit log table, basic red-team regex filter.
- Week 5: Happy-path E2E test, stronger CLI dev flow, README setup polish.
- Week 6: Ollama adapter toggle, cron scheduler, minimal web viewer for task logs.
