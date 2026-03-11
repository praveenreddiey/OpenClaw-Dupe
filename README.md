# Claw Dupe

Developers: read `AGENTS.md` before making changes.

Quick start

1. `npm install`
2. Fill in `config.yaml` with your local values, especially `telegram.botToken`.
3. `npm run build`
4. `npm start`
5. Visit `http://localhost:3000/health`

Telegram webhook

1. Set `telegram.botToken` in `config.yaml`.
2. Optional: set `telegram.webhookSecret` for request validation.
3. Adjust `telegram.requestTimeoutMs` if you want a different outbound timeout.
4. Point Telegram at the configured `telegram.webhookPath`.
5. POST updates to that route and the bot will echo text messages back.

Notes

- Source lives in `src/`; compiled output is generated in `dist/`.
- `npm run dev` currently does a build and starts the compiled server. Watch mode can be improved later.
- `npm test` builds the project and runs the compiled Node test suite.
- `npm start` now validates the Telegram runtime config before boot and fails fast if `telegram.botToken` is missing.
- Keep `config.yaml` out of git.

- register the webhook after every deployment(once its registered, telegram posts messages to this url)(role of developer)

  $token = ""
    $webhookUrl = "/telegram/webhook"
    $secret = "my-secret-123"   # pick anything, but keep it in config too
    Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -ContentType "application/json" -Body (@{
  url = $webhookUrl
  secret_token = $secret
  drop_pending_updates = $true
  allowed_updates = @("message","edited_message")
  } | ConvertTo-Json)

--docker build

docker compose --env-file .env down
docker compose --env-file .env up --build

Roadmap

- Week 0: Init repo, TS config, config example, health check route. [done]
- Week 1: Telegram webhook + echo bot, SQLite message model, pino logging. [done]
- Week 2: LLM adapter (streaming OpenAI), simple planner prompt, SSE to Telegram replies.
- Week 3: Skill runner in worker threads with time and memory limits, `fs_read`, `fs_write`, path allowlist.
- Week 4: `shell_exec` skill with command allowlist and output cap, audit log table, basic red-team regex filter.
- Week 5: Happy-path E2E test, stronger CLI dev flow, README setup polish.
- Week 6: Ollama adapter toggle, cron scheduler, minimal web viewer for task logs.
