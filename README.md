# claude-code-telegram-notify

Хук `Stop` для Claude Code: когда Claude заканчивает ответ, вам в Telegram приходит сообщение.

Claude Code `Stop` hook: pings you in Telegram when Claude finishes a reply.

## Что в сообщении / What you get

```
my-project

Готово: всё работает.          ← начало ответа, Markdown превращён в Telegram-разметку

┃ Время   14:17:15 → 14:18:13 · 58 с
┃ Модель  claude-sonnet-5-5 · контекст 430.5k
┃ Ответ   ≈$0.248 · 3 выз. · вх 8 · вых 8.6k · кэш 1.3M / 8.8k
┃ Сессия  с 09:18 · ≈$31.28 · 83 выз. · вх 1.3k · вых 202.6k · кэш 20M / 1.3M
```

- проект (имя папки) и начало ответа (до 700 символов): `**жирный**`, заголовки, `код`, блоки кода, списки, ссылки, таблицы;
- когда ответ начался, закончился и сколько шёл;
- модель и размер контекста;
- токены и стоимость за этот ответ и за всю сессию, по прайсу API (кэш и своя модель на каждый вызов; по подписке вы столько не платите — это «сколько стоило бы»);
- если Telegram отклонит разметку, то же сообщение уходит обычным текстом.

Нужен Node.js 18+ (используется встроенный `fetch`). Зависимостей нет.

## Установка / Setup

1. Создайте бота у [@BotFather](https://t.me/BotFather), напишите ему любое сообщение и узнайте свой chat id (`getUpdates`, см. `.env.example`).
2. Положите скрипт, например, в `~/.claude/telegram-notify.mjs`, а токен — в `~/.claude/telegram-notify.env`:

   ```
   TELEGRAM_NOTIFY_TOKEN=123456789:...
   TELEGRAM_NOTIFY_CHAT_ID=123456789
   ```

   Или задайте те же переменные в окружении. Файл можно положить в другое место: `TELEGRAM_NOTIFY_ENV=/path/to/file`.
3. Подключите хук в `~/.claude/settings.json`:

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

Токен нигде не хранится в самом скрипте. Нет токена или chat id — хук молча ничего не делает и сессию не ломает.

## Переключатели / Switches

| Что | Как |
|---|---|
| Проверить, не отправляя | `TG_NOTIFY_DRY=1` — печатает сообщение и говорит, нашёлся ли токен |
| Посмотреть ответ Telegram | `TG_NOTIFY_DEBUG=1` |
| Временно выключить | создать файл `~/.claude/telegram-notify.paused` (удалить — снова включится) |

Пример проверки (хук получает JSON на stdin):

```bash
echo '{"cwd":"/my/project","last_assistant_message":"**Привет**"}' | TG_NOTIFY_DRY=1 node telegram-notify.mjs
```

## Цены / Prices

Таблица `PRICES` в начале скрипта: `[вход, выход, чтение кэша]` в долларах за 1M токенов. Запись в кэш считается как 1.25× входа (5 минут) или 2× (1 час), быстрый режим — вдвое дороже. Новой модели в таблице нет — добавьте строку, иначе цена будет с пометкой `+?`. Цены на 2026-11-03: сверяйте с [прайсом Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).

## English summary

A `Stop` hook for Claude Code that sends a Telegram message after every reply: the start of the reply (Markdown converted to Telegram HTML), when it started and ended, the model, token counts and the cost at API list prices, for the reply and for the whole session. The bot token and chat id are read from `TELEGRAM_NOTIFY_TOKEN` / `TELEGRAM_NOTIFY_CHAT_ID` (environment or `~/.claude/telegram-notify.env`), never from the script. Node 18+, no dependencies. `TG_NOTIFY_DRY=1` prints the message without sending it.
