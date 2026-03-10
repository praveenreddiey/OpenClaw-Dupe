# AGENTS: Development Rules

These instructions apply to all work in this repo. Read before each change.

## Security and secrets

- Never commit `config.yaml` `.env` or secrets. Keep `config.yaml` for local use only.
- Default to no external network in future skills; be explicit when enabling it.
- Do not log API keys, tokens, or personally identifiable information.

## Code style

- TypeScript strict mode; prefer async/await.
- Keep functions small and focused; avoid global state.
- Use Fastify's `app.log` for logging and include useful request context when available.

## Config

- Load settings only through `src/config.ts`.
- Provide safe defaults where appropriate, but fail fast on required production settings.

## Errors and responses

- Routes should catch failures and return JSON errors with an HTTP status and `{ error: message }`.
- Do not leave unhandled promise rejections in the process.

## Testing and checks

- After code changes run `npm run build`.
- Add or update unit tests for new behavior whenever possible.

## Dependencies

- Add runtime dependencies intentionally; keep tooling in `devDependencies`.
- Avoid pulling in heavy packages unless they solve a real problem.

## Docs

- Keep `README.md` in sync when adding major features or commands.

## Process obligations

- After each milestone or feature completion, summarise what we have achieved in that milestone and append a dated note to `docs/DEVLOG.md` with what changed
- If a test is intentionally skipped, record the reason in `docs/DEVLOG.md`.
- After each weekly milestone completion, perform a code review focused on:
  - performance issues
  - architectural problems
  - functional correctness
  - concurrency or threading issues
  - code quality and maintainability
  - error handling and resilience
  - opportunities for optimization or simplification
- Record the review results in `ISSUES.md`. If no issues are found, explicitly say so for that milestone.
