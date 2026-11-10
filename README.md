# claude-code-telegram-notify

Telegram notifications for [Claude Code](https://claude.com/claude-code) — and a way to answer them from your phone.

- A **`Stop` hook** sends you a message when Claude finishes a reply: the start of the reply (Markdown rendered as Telegram HTML), when it started and ended, the model, the tokens and what they cost at API list prices.
- An optional **reply channel**: swipe-reply to a notification in Telegram, and your text reaches *that* Claude Code session as if you had typed it in the terminal. Waiting for your reply costs **no tokens** — it is done by a small plain Node process, not by the model.

Node.js 18+ is the only requirement. No dependencies, no build step.

```
my-project

Done: the migration is written and the tests pass.

┃ Time     14:17:15 → 14:18:13 · 58 s
┃ Model    claude-sonnet-5-5 · context 430.5k
┃ Reply    ≈$0.248 · 3 calls · in 8 · out 8.6k · cache 1.3M / 8.8k
┃ Session  since 09:18 · ≈$31.28 · 83 calls · in 1.3k · out 202.6k · cache 20M / 1.3M
```

> The labels in the message itself are in Russian (`Время`, `Модель`, `Ответ`, `Сессия`, `выз.`, `вх`, `вых`, `кэш`) — change the strings in `footer()` in `telegram-notify.mjs` if you want another language.

## Contents

- [Setup](#setup)
- [The notification](#the-notification)
- [Replying from Telegram](#replying-from-telegram)
- [Configuration](#configuration)
- [Files](#files)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy its token. Write any message to the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id` — that is your chat id.
2. **Copy the scripts** (`telegram-*.mjs`) into `~/.claude/` and put the credentials next to them in `~/.claude/telegram-notify.env` (see [`.env.example`](.env.example)):

   ```
   TELEGRAM_NOTIFY_TOKEN=123456789:replace-with-your-bot-token
   TELEGRAM_NOTIFY_CHAT_ID=123456789
   ```

   The token is never stored in a script. You may set the same two variables in the environment instead.
3. **Register the hook** in `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             { "type": "command", "command": "node C:/Users/you/.claude/telegram-notify.mjs", "async": true }
           ]
         }
       ]
     }
   }
   ```

4. **Check it** without sending anything:

   ```bash
   echo '{"cwd":"/my/project","last_assistant_message":"**Hello**"}' | TG_NOTIFY_DRY=1 node telegram-notify.mjs
   ```

   It prints the message and tells you whether the token and chat id were found. Without them the hook silently does nothing and never fails your session.

That is all for notifications. For replies, see the next sections.

## The notification

The hook reads the session's transcript (`transcript_path` from the hook input) and builds the message:

| Part | Source |
|---|---|
| Project | the name of the working directory |
| Reply text | the last assistant message, cut at 700 characters, then converted from Markdown: `**bold**`, headings, `` `code` ``, fenced code, lists, links and tables (tables become monospaced blocks) |
| Time | the start of the turn (your last message), its end, and the duration |
| Model, context | the model of the last reply and the size of its context |
| Tokens, cost | input, output and cache tokens of this reply and of the whole session |

If Telegram rejects the markup, the same message is sent again as plain text.

**Cost** is computed per API call, with the price of the model that made that call (a session can mix models), from the `PRICES` table at the top of `telegram-notify.mjs`: `[input, output, cache read]` in dollars per million tokens. A cache write is priced at 1.25× the input price (5-minute TTL) or 2× (1-hour TTL); fast mode counts double. These are API list prices: on a subscription you do not pay them, read the number as "what it would cost". A model that is not in the table is marked `+?` — add a line for it. Prices are as of 2026-11-03; check the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing).

## Replying from Telegram

```
 Claude Code session ──Stop hook──▶ Telegram ──▶ you
        ▲   │ writes message_id → session_id          │ reply to the notification
        │   ▼                                         ▼
  Monitor tool ◀── inbox/<session>.jsonl ◀── telegram-inbox.mjs (long-polls getUpdates)
  (telegram-inbox-watch.mjs)
```

1. When the hook sends a notification it records which Claude Code session sent it (`message_id → session_id`) in `~/.claude/telegram-inbox/routes.jsonl`, and starts the **inbox daemon** (`telegram-inbox.mjs`) if it is not running. There is one daemon for all your sessions, because a bot can be polled by one process only.
2. The daemon long-polls Telegram. It does no model calls, so waiting costs nothing. A message you send is routed like this:
   - a **reply** to a notification goes to the session that sent *that* notification, with the quoted text attached;
   - any **other message** goes to the session that sent the latest notification;
   - only your chat id is accepted — anyone else who writes to the bot is ignored;
   - the daemon puts a 👀 reaction under every message it accepts, so you see it arrived.
3. The session listens to its own inbox with Claude Code's **`Monitor`** tool, which runs a command and delivers every line it prints to the agent as an event:

   ```
   node ~/.claude/telegram-inbox-watch.mjs <session_id>
   ```

   Each message becomes one line, `[Telegram (my-project), reply to «…»] your text`, which the agent treats as if you had typed it. While you write nothing, the watcher prints nothing and no tokens are spent.

### Starting the watcher in a session

Either ask the agent once per session — *"start the Monitor with `node ~/.claude/telegram-inbox-watch.mjs <session id>`"* — or register the optional **`SessionStart` hook**, which tells the agent how to do it by itself (it adds a couple of lines of context once per session):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node C:/Users/you/.claude/telegram-inbox-hint.mjs" } ] }
    ]
  }
}
```

### What to expect

- It works while the session is open. If you close Claude Code, nobody is there to read the reply (the message stays in the inbox until the watcher for that session is started again).
- Only text is accepted. A photo, a voice message or a sticker gets a one-line answer saying so.
- The first time the daemon starts it ignores everything written before — old messages are not replayed as instructions.
- The daemon ends by itself after 12 hours without a notification and is started again by the next one.
- **Everything that reaches the inbox is treated as an instruction from you.** That is why only your own chat id is accepted. Do not add the bot to groups, and keep the token secret.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `TELEGRAM_NOTIFY_TOKEN` | bot token | — |
| `TELEGRAM_NOTIFY_CHAT_ID` | your chat id; the only one accepted | — |
| `TELEGRAM_NOTIFY_ENV` | path of the `KEY=VALUE` file with the two above | `~/.claude/telegram-notify.env` |
| `TELEGRAM_NOTIFY_INBOX` | `off` — no reply channel: no routes recorded, no daemon started | on |
| `TELEGRAM_NOTIFY_DATA` | where the daemon keeps routes, inboxes, offset, pid and log | `~/.claude/telegram-inbox` |
| `TELEGRAM_NOTIFY_IDLE_HOURS` | the daemon ends after this many hours without a notification | `12` |
| `TG_NOTIFY_DRY` | `1` — print the message, send nothing | off |
| `TG_NOTIFY_DEBUG` | `1` — print what was sent and what Telegram answered | off |

To pause the notifications for a while, create the file `~/.claude/telegram-notify.paused`; delete it to resume.

## Files

| File | Role |
|---|---|
| `telegram-notify.mjs` | the `Stop` hook: builds and sends the notification, records the route, starts the daemon |
| `telegram-inbox.mjs` | the daemon: polls Telegram, routes your messages into per-session inboxes |
| `telegram-inbox-watch.mjs` | run by `Monitor` in a session: prints that session's new messages, one per line |
| `telegram-inbox-hint.mjs` | optional `SessionStart` hook that tells the agent to start the watcher |
| `telegram-lib.mjs` | shared: configuration, paths, helpers |
| `test/inbox.test.mjs` | tests of the daemon and the watcher against a fake Telegram |
| `.env.example` | the credentials file to copy |

Runtime data lives in `~/.claude/telegram-inbox/`: `routes.jsonl` (the last 7 days), `inbox/<session>.jsonl`, `offset.json`, `daemon.pid`, `daemon.log`.

## Troubleshooting

- **No notification.** Run the dry command from [Setup](#setup) and look at the last line: `token and chat id: MISSING` means the env file is not found. Then `TG_NOTIFY_DEBUG=1` shows what Telegram answered.
- **Messages in plain text, no formatting.** Telegram refused the markup and the fallback was used; `TG_NOTIFY_DEBUG=1` shows why.
- **My reply is not delivered.** Look at `~/.claude/telegram-inbox/daemon.log`. `getUpdates failed: Conflict` (409) means something else polls this bot — a webhook or another program using the same token. A bot can have only one consumer: use a separate bot for these notifications.
- **The reply arrives in the inbox but the agent does not react.** The watcher must be running in that session (the `Monitor` tool). Check that the session id in the command is the session's own.
- **I do not want replies at all.** Set `TELEGRAM_NOTIFY_INBOX=off`.

## Development

```bash
npm test        # node --test test/inbox.test.mjs
```

The tests start the daemon and the watcher against a local fake of the Telegram API (`TELEGRAM_NOTIFY_API`), so nothing leaves the machine.
