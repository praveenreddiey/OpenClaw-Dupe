# Claw Dupe

Developers: read `AGENTS.md` before making changes.

## Code Flow

![Code flow diagram](docs/code-flow.png)

## What It Does

Claw Dupe is a Telegram-first assistant server built on Fastify. It can:

- receive Telegram webhooks
- plan and stream LLM replies
- use live lookup for freshness-sensitive prompts
- read and write approved files with `fs_read` and `fs_write`
- execute a strict allowlist of shell commands with `shell_exec`
- require manual confirmation before mutating shell commands run
- schedule recurring LLM-backed tasks with cron-style schedules
- expose a minimal web log viewer for scheduled runs and shell audits
- switch between OpenAI and Ollama for the main LLM adapter

## Quick Start

1. `npm install`
2. Copy `config.example.yaml` to `config.yaml`
3. Fill in `telegram.botToken` and `telegram.webhookSecret`
4. Set secrets in your shell, especially `OPENAI_API_KEY` when using `llm.provider: openai`
5. `npm run build`
6. `npm start`
7. Visit `http://localhost:3000/health`
8. Visit `http://localhost:3000/logs` for the minimal task/audit viewer

## Development Commands

- `npm run dev`
  Starts the server in watch mode through `tsx`.
- `npm run build`
  Compiles `src/` and `tests/` into `dist/`.
- `npm start`
  Runs the compiled server.
- `npm test`
  Builds and runs the compiled Node test suite.
- `npm run lint`
  Runs TypeScript type-checking without emitting files.
- `npm run check`
  Runs `lint` and `test`.
- `npm run reset-db`
  Deletes the configured SQLite database and its WAL/SHM sidecars inside the workspace.
- `npm run redeploy:telegram`
  Runs `docker compose --env-file .env down` and then `docker compose --env-file .env up --build -d`.
- `npm run webhook:update`
  Reads the latest Cloudflare tunnel URL from Docker logs and updates Telegram webhook without restarting Docker.

## Telegram Webhook Flow

1. Telegram POSTs an update to `telegram.webhookPath`
2. Fastify verifies the Telegram secret header
3. The app rate-limits, stores the incoming message, and replies to Telegram quickly
4. A background task sends a placeholder reply
5. The app either:
   - handles a direct skill request
   - tries live lookup for freshness-sensitive questions
   - or plans and generates a normal LLM reply
6. The final Telegram reply is edited or sent
7. Incoming and outgoing message state is stored in SQLite

## File Skills

Week 3 is now live through Telegram:

- `/fs_read <path>`
- `/fs_write <path>` followed by a newline and the content

Natural language maps to the same file skills:

- `Save file name as notes.txt content is hello`
- `Read file notes.txt`

Safety rules:

- file access is restricted to `skills.allowedPaths`
- dangerous paths in `skills.blockedPaths` stay blocked
- reads and writes have byte caps
- work runs inside isolated worker threads
- every skill still returns structured `success`, `output`, `error`

## Shell Skill

Week 4 adds direct shell execution through:

- `/shell_exec <command>`
- `run command <command>`
- `execute command <command>`

The shell path is strict by design:

- only exact commands in `skills.shellAllowlist` are allowed
- dangerous executables such as `rm`, `sudo`, `chmod`, `curl`, `wget`, and shell-eval wrappers are blocked
- command output is capped by `skills.shellMaxOutputBytes`
- commands run inside `skills.shellWorkingDirectory`
- risky prompts are blocked by a red-team regex layer
- mutating commands must set `requiresConfirmation: true`
- confirmation happens over Telegram with `/confirm_shell <token>` or `/cancel_shell <token>`
- every shell command attempt is written to the SQLite `tool_audit_logs` table

Example:

```text
/shell_exec git status --short
```

```text
/shell_exec npm run build
```

The second example requires confirmation before it runs because the default allowlist marks it as mutating.

## LLM Provider Toggle

Week 6 adds a provider switch:

- `llm.provider: openai`
- `llm.provider: ollama`

OpenAI notes:

- use `OPENAI_API_KEY`
- default base URL is `https://api.openai.com/v1`

Ollama notes:

- no API key is required
- default base URL is `http://127.0.0.1:11434`
- planner JSON responses are normalized and validated before use

## Scheduler And Viewer

Week 6 also adds a small cron-style scheduler plus a minimal viewer.

Scheduler config lives under `scheduler`:

- `enabled`
- `pollIntervalMs`
- `runTimeoutMs`
- `rateLimitWindowMs`
- `rateLimitMaxRuns`
- `tasks`

Each task includes:

- `name`
- `schedule`
- `prompt`
- `enabled`
- `maxOutputTokens`
- `telegramChatId` (optional, sends the task output to that Telegram chat)
- `runOnce` (optional, disables the task after its first successful delivery)

Example task that sends a Telegram message every 2 minutes:

```yaml
scheduler:
  enabled: true
  pollIntervalMs: 10000
  runTimeoutMs: 30000
  rateLimitWindowMs: 60000
  rateLimitMaxRuns: 10
  tasks:
    - name: "two-minute-reminder"
      schedule: "*/2 * * * *"
      prompt: "Send one short check-in message saying the scheduler is working."
      enabled: true
      maxOutputTokens: 80
      telegramChatId: "123456789"
```

The scheduler:

- stores tasks in SQLite
- logs every run into `scheduled_task_runs`
- tracks duration and errors
- prevents overlapping runs with a DB-backed `is_running` flag
- rate-limits background task starts
- optionally sends the completed task output as a Telegram text message when `telegramChatId` is set
- stores delivered scheduled Telegram messages in the normal SQLite `messages` table as outgoing records

## Chat Reminders

When `scheduler.enabled` is on, you can create reminders directly from Telegram.

Example:

```text
remind me every 10 minutes to drink water
set a remainder to drink water every 2 minutes
```

Supported variations:

```text
set a reminder at 2:36pm IST to go shopping
set a remainder at 2:36pm IST to go shopping
set the remainder at 2:54pm to go shopping
```

One-time example:

```text
remind me to send email in 1 minute
```

Specific-time example:

```text
remind me at 2pm to send email
```

Exact-date example:

```text
remind me on 31 March at 2pm to send email
```

Tomorrow example:

```text
remind me tomorrow at 9:15am to join standup
```

What happens:

- the bot creates or updates a scheduled task for that chat
- the timing is parsed dynamically from your message
- the reminder text is sent back deterministically as a reminder message, without relying on LLM phrasing
- sending the same reminder text again with a different interval or clock time updates that reminder instead of creating a duplicate for the same chat/message
- if you use `at 2pm` and that time has already passed today, the bot schedules it for the next day
- if you use `on 31 March at 2pm` without a year and that date has already passed this year, the bot schedules it for the next year
- one-time reminders disable themselves after the first successful send

Current reminder limits:

- chat-created reminders support `1` to `59` minute intervals
- `scheduler.enabled` must be `true`

Reminder management from Telegram:

```text
list my reminders
list the remainders
cancel reminder send email
/cancel_reminder 12
```

- `list my reminders` and `list the remainders` show active reminders for the current chat, including their ids
- `cancel reminder ...` disables matching reminders for the current chat only
- `/cancel_reminder <id>` disables one specific reminder by id

The viewer is enabled through `viewer` and defaults to:

- HTML: `GET /logs`
- JSON: `GET /logs.json`

## Config Highlights

Important sections in `config.yaml`:

- `llm`
- `liveLookup`
- `skills`
- `scheduler`
- `viewer`
- `telegram`

The safest shell defaults are:

```yaml
skills:
  shellEnabled: true
  shellWorkingDirectory: "./"
  shellMaxOutputBytes: 16384
  shellAllowlist:
    - command: "git status --short"
      requiresConfirmation: false
    - command: "npm test"
      requiresConfirmation: false
    - command: "npm run build"
      requiresConfirmation: true
```

## Testing

Current test coverage includes:

- Telegram webhook happy path
- direct file skills
- shell confirmation flow
- config validation
- SQLite schema and persistence
- OpenAI and Ollama adapters
- scheduler execution
- shell policy
- planner and live lookup behavior
- viewer routes

External APIs are mocked in tests, and the shell skill is exercised through stubs in the app integration tests so test runs do not execute real shell commands.

## CI

GitHub Actions now runs:

- `npm ci`
- `npm run lint`
- `npm test`

See [`.github/workflows/ci.yml`](/C:/Users/prave/OneDrive/Documents/Claw%20Dupe/.github/workflows/ci.yml).

## Docker Notes

The current `docker-compose.yml` mounts:

- `config.yaml`
- `data/`
- `C:/Users/prave/Downloads/ClawAllowed` as `/app/clawallowed`
- the repo itself as `/app/workspace`

Docker shell execution is now enabled safely with:

- `SKILLS_ALLOWED_PATHS=/app/clawallowed;/app/workspace`
- `SKILLS_BLOCKED_PATHS=/app/workspace/.env;/app/workspace/config.yaml;/app/workspace/.git;/app/workspace/node_modules;/app/workspace/dist`
- `SKILLS_SHELL_ENABLED=true`
- `SKILLS_TIMEOUT_MS=15000`
- `SKILLS_SHELL_WORKING_DIRECTORY=/app/workspace`
- `SKILLS_SHELL_ALLOWLIST=git status --short;npm run lint;npm run build`
- `LLM_PLANNER_MAX_RESPONSE_TOKENS=240`
- a dedicated `workspace_node_modules` Docker volume so `/app/workspace` uses Linux-compatible dependencies instead of the host `node_modules`
- `git` installed inside the app image

That means:

- file skills can still use `/app/clawallowed/...`
- shell commands run only inside `/app/workspace`
- shell commands are limited to `git status --short`, `npm run lint`, and `npm run build`
- `npm run build` still requires Telegram confirmation before execution

Clock-time reminders in Docker follow the container timezone. The app service now sets:

- `TZ=${TZ:-Asia/Calcutta}`

So `remind me at 2pm to send email` is interpreted in your local timezone instead of UTC. If you want a different timezone later, set `TZ` in `.env` before starting Docker.

## Docker Redeploy Helper

If you are using the Cloudflare quick tunnel, the public `trycloudflare.com` URL can change after a rebuild. The repo now includes a one-command helper:

```text
npm run redeploy:telegram
```

It will:

- stop the current Docker Compose stack
- rebuild and restart the stack in detached mode

Then run this separately when you want webhook refresh:

```text
npm run webhook:update
```

`webhook:update` will:

- load `.env` locally so the Telegram bot token is available without printing it
- poll the `tunnel` container logs until a fresh `https://...trycloudflare.com` URL appears
- retry the Telegram webhook update while the new quick-tunnel hostname is still propagating
- append `telegram.webhookPath` (so `/telegram/webhook` stays fixed)
- call Telegram `setWebhook` with `drop_pending_updates: true`
- include `telegram.webhookSecret` when it is configured through `config.yaml` or `TELEGRAM_WEBHOOK_SECRET`

If you prefer two explicit steps, run:

```text
docker compose --env-file .env down
docker compose --env-file .env up --build -d
npm run webhook:update
```

## Roadmap Status

- Week 0: Init repo, TS config, config example, health check route. [done]
- Week 1: Telegram webhook + echo bot, SQLite message model, pino logging. [done]
- Week 2: LLM adapter, planner prompt, streamed Telegram replies. [done]
- Week 3: Worker-thread file skills with allowlists and limits. [done]
- Week 4: Guarded `shell_exec`, audit logs, red-team filter. [done]
- Week 5: Happy-path E2E coverage, stronger CLI flow, README polish, CI. [done]
- Week 6: Ollama toggle, cron scheduler, minimal log viewer. [done]

## Notes

- Source lives in `src/`
- Compiled output is generated in `dist/`
- `config.yaml` stays local and should never be committed
- SQLite prefers WAL mode but falls back automatically when WAL shared-memory files are unavailable
