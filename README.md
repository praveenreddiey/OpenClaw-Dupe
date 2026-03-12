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
2. Set `telegram.webhookSecret` so webhook requests are verified with Telegram's secret header.
3. Adjust `telegram.requestTimeoutMs` if you want a different outbound timeout.
4. Tune `telegram.rateLimitWindowMs` and `telegram.rateLimitMaxRequests` to limit chat spam.
5. Point Telegram at the configured `telegram.webhookPath`.
6. POST updates to that route and the bot will echo sanitized text messages back.

Notes

- Source lives in `src/`; compiled output is generated in `dist/`.
- `npm run dev` currently does a build and starts the compiled server. Watch mode can be improved later.
- `npm test` builds the project and runs the compiled Node test suite.
- `npm start` now validates the Telegram runtime config before boot and fails fast if `telegram.botToken` is missing.
- Incoming and outgoing Telegram messages are logged with metadata only, stored with `chat_id`, `user_id`, `message_id`, timestamps, and a status of `received`, `processed`, or `failed`.
- SQLite adds indexes for chat, user, message, and timestamp lookups to keep message history queries fast.
- SQLite prefers WAL mode, but automatically falls back to `DELETE` journal mode on Docker/Desktop bind mounts or synced folders that cannot open WAL shared-memory files.
- Inbound webhook handling now flows through a transport-neutral `UnifiedMessage` shape, with Telegram-specific parsing and delivery isolated in `TelegramAdapter` so future adapters can plug in more easily.
- Keep `config.yaml` out of git.

- register the webhook after every deployment(once its registered, telegram posts messages to this url)(role of developer)

  $token = "8556974125:AAH-Ogtt2Sy0c_y2MVcXG9wE2LSX_4r6psI"
    $webhookUrl = "https://migration-separation-acrylic-philadelphia.trycloudflare.com/telegram/webhook"
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

- Week 1: Telegram webhook + echo bot, SQLite message model, pino logging
  Gateway & Adapters
  Decouple: Use UnifiedMessage interface. Add TelegramAdapter now; Slack/WhatsApp become simple plugins later.

- Week 2: LLM adapter (streaming OpenAI), simple planner prompt, SSE to Telegram replies.
- Week 3: Skill runner in worker threads with time and memory limits, `fs_read`, `fs_write`, path allowlist.
- Week 4: `shell_exec` skill with command allowlist and output cap, audit log table, basic red-team regex filter.
- Week 5: Happy-path E2E test, stronger CLI dev flow, README setup polish.
- Week 6: Ollama adapter toggle, cron scheduler, minimal web viewer for task logs.

  Week 7: The "Eyes" (Browser Use & Vision)To book flights or check wedding venues, your bot needs to see the web like a human.The Tech: Integrate Playwright or Stagehand. Instead of just scraping HTML (which is messy and expensive), use Semantic Snapshots.How it works: The agent converts a webpage into a "simplified tree" of buttons and links (e.g., [12] "Search Flights" button). It then chooses actions like click(12) or type("Chennai").Day-to-Day: Send a link to a Zomato menu and say, "Order my usual chicken biryani if it's under ₹400." The bot logs in, checks the price, and handles the checkout.

Week 8: Semantic Memory (The "Brain" Expansion)SQLite is good for logs; a Vector Database (like ChromaDB or Pinecone) is for "experience."The Tech: Every conversation and file the bot "reads" gets turned into a vector (a mathematical representation of meaning).How it works: When you ask, "What did the bike mechanic say about the chain last year?", the bot doesn't just search for "chain"—it searches for the concept of bike maintenance and finds the specific chat or PDF from months ago.Day-to-Day: The bot remembers that you prefer late-night flights and that your Gujarati lessons are currently focused on "family vocabulary," and it tailors its suggestions without being asked.

Markdown Memory Persistence: Use MEMORY.md (truth) + logs/ (episodes). Distill: Auto-summarize logs to MD nightly.(just like open claw) dont use any vector database

Week 9: Multi-Agent Handoffs (The "Squad")OpenClaw’s power comes from specialized agents. You can create a "Lane Queue" system where different agents handle different domains.The Roles:The Coder: Has full shell_exec access to your projects.The Researcher: Has browser_use to find flight prices or tech documentation.The Financial Manager: Only has access to your investment.db.Day-to-Day: You give one command: "Plan my Munnar trip." The Researcher finds flights; the Financial Manager checks if the ₹30 Lakh goal is safe; the Coder generates a calendar invite. They "talk" to each other to give you one final answer.

Week 10: "Computer Use" (Local GUI Control)This is the current "State-of-the-Art" in 2026.The Tech: Use libraries like nut.js or RobotJS to let the AI control your actual mouse and keyboard.The Action: The AI can open your VS Code, move files into your Spotify, or fill out complex government forms (like a passport application) by looking at your screen.Safety: You implement a "Human-in-the-Loop" check where the bot sends a screenshot to Telegram and asks, "I'm about to click 'Pay Now'. Confirm?"

precautions

Week 0

Init repo, TS config, config example, health check route

Precautions

Never commit secrets (Telegram token, API keys). Use .env and .gitignore.

Lock your Node version using .nvmrc.

Enable strict TypeScript settings (strict: true).

Validate configuration values on startup to avoid runtime failures.

Best Standards

Use a single centralized config loader.

Add ESLint + Prettier early to maintain consistent code style.

Use structured logging from day one.

Add a simple /health endpoint that checks DB connection and server status.

Week 1

Telegram webhook + echo bot, SQLite message model, pino logging.

Precautions

Verify webhook requests using a Telegram secret token.

Add rate limiting to prevent spam or abuse.

Sanitize incoming messages before storing them.

Ensure database writes are wrapped in error handling.

Best Standards

Store chat_id, user_id, message_id, and timestamp.

Log every incoming message and every outgoing response.

Create a message status field (received, processed, failed).

Use indexed columns in SQLite to keep queries fast.

Week 2

LLM adapter (streaming OpenAI), simple planner prompt, SSE to Telegram replies.

Precautions

Separate system prompts from user input to reduce prompt injection risks.

Limit token usage and set max response tokens to control costs.

Log prompts and completions for debugging.

Implement request timeouts for LLM calls.

Best Standards

Create a unified LLM interface (generate, stream, embeddings).

Design the planner prompt to be deterministic and clear.

Implement streaming responses for better user experience.

Add model configuration in environment variables for easy switching.

Week 3

Skill runner in worker threads with time and memory limits, fs_read, fs_write, path allowlist.

Precautions

Enforce strict execution time limits for every skill.

Restrict file access using a path allowlist (never allow /).

Prevent large file reads that could crash memory.

Kill worker threads if they exceed limits.

Best Standards

Standardize skill responses (success, output, error).

Log every tool call with duration and result size.

Keep tools simple and single-purpose.

Isolate worker threads from the main server process.

Week 4

shell_exec skill with command allowlist and output cap, audit log table, basic red-team regex filter.

Precautions

Never allow arbitrary commands; enforce a strict allowlist.

Block dangerous commands such as rm, sudo, chmod, curl, wget.

Limit command output size to prevent memory overload.

Execute shell commands in a sandbox directory.

Best Standards

Maintain an audit log table for every executed command.

Implement a basic red-team regex filter to detect risky prompts.

Log the user request, command executed, and command output.

Add manual confirmation for commands that modify files.

Week 5

Happy-path E2E test, stronger CLI dev flow, README setup polish.

Precautions

Mock external APIs during tests to avoid unnecessary costs.

Ensure test environments cannot trigger real shell commands.

Keep test databases separate from production databases.

Best Standards

Create end-to-end tests covering the main user flow.

Provide CLI commands for development (start, test, reset-db).

Document setup clearly in README.

Automate linting and tests in CI pipelines.

Week 6

Ollama adapter toggle, cron scheduler, minimal web viewer for task logs.

Precautions

Validate responses from local models since they may produce malformed JSON.

Prevent cron jobs from running concurrently if they overlap.

Add rate limits to background tasks.

Best Standards

Implement a toggle to switch between OpenAI and Ollama.

Store scheduled tasks in the database.

Display task history in a simple log viewer.

Track execution duration and errors for scheduled jobs.

Week 7

The "Eyes" (Browser Use & Vision)

To book flights or check wedding venues, your bot needs to see the web like a human.

The Tech: Integrate Playwright or Stagehand. Instead of just scraping HTML (which is messy and expensive), use Semantic Snapshots.

How it works: The agent converts a webpage into a simplified tree of buttons and links (e.g., [12] "Search Flights" button). It then chooses actions like click(12) or type("Chennai").

Day-to-Day: Send a link to a Zomato menu and say, "Order my usual chicken biryani if it's under ₹400." The bot logs in, checks the price, and handles the checkout.

Precautions

Limit the number of browser actions per task.

Add page load timeouts to prevent hanging sessions.

Avoid automatic form submissions without confirmation.

Block payment actions unless the user confirms.

Best Standards

Use accessibility trees instead of raw HTML for navigation.

Take screenshots for debugging failed browser tasks.

Cache page snapshots when possible to reduce repeated browsing.

Log every browser interaction step.

Week 8

Semantic Memory (The "Brain" Expansion)

SQLite is good for logs; a Vector Database (like Chroma or Pinecone) is for experience.

The Tech: Every conversation and file the bot reads gets turned into a vector (a mathematical representation of meaning).

How it works: When you ask, "What did the bike mechanic say about the chain last year?", the bot searches for the concept of bike maintenance and retrieves the relevant chat or document.

Day-to-Day: The bot remembers that you prefer late-night flights and that your Gujarati lessons are focused on family vocabulary.

Precautions

Avoid embedding sensitive information such as passwords or API keys.

Limit memory growth by summarizing old conversations.

Add metadata filters to prevent irrelevant memory retrieval.

Best Standards

Store timestamps and topic tags with every memory entry.

Implement memory summarization to compress long conversations.

Separate temporary context from long-term memory.

Monitor vector database size regularly.

Week 9

Multi-Agent Handoffs (The "Squad")

Systems like OpenClaw use specialized agents. You can create a lane queue system where different agents handle different domains.

Roles:

The Coder: Full shell_exec access.

The Researcher: Browser automation to find information.

The Financial Manager: Access only to financial data.

Day-to-Day: You give one command: "Plan my Munnar trip." Agents coordinate to produce a final answer.

Precautions

Limit the number of agent handoffs to prevent infinite loops.

Restrict each agent’s permissions strictly.

Track communication between agents to detect errors.

Best Standards

Use a central planner agent to coordinate tasks.

Keep agents specialized and minimal in capability.

Log all agent decisions and results.

Implement a task queue to manage agent workflows.

Week 10

Computer Use (Local GUI Control)

The Tech: Use libraries like nut.js or RobotJS to control the mouse and keyboard.

The Action: The AI can open VS Code, move files into Spotify, or fill out complex forms by observing the screen.

Safety: Implement a Human-in-the-Loop system where the bot sends a screenshot to Telegram and asks for confirmation before critical actions.

Precautions

Always require confirmation for actions involving payments, file deletion, or system changes.

Run GUI automation inside a virtual machine when possible.

Restrict the directories and applications the AI can control.

Best Standards

Capture screenshots before and after each action.

Maintain detailed logs of mouse and keyboard actions.

Implement a cancel command that stops all ongoing automation.

Limit automation session duration to avoid runaway processes.

✅ If you want, I can also create a visual timeline + architecture evolution diagram from Week 0 → Week 10, which makes it much easier to understand how the system grows over time.

Get smarter responses, upload files and images, and more.
