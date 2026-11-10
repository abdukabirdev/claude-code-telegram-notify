// The inbox daemon: asks Telegram for new messages and puts each into the inbox of the Claude Code
// session it is meant for. No model is involved here, so waiting costs no tokens.
//
//  - a reply to one of the hook's notifications goes to the session that sent it;
//  - any other message goes to the session that sent the latest notification;
//  - only the owner's chat counts (TELEGRAM_NOTIFY_CHAT_ID): whatever else writes to the bot is ignored.
//
// Started by the hook (telegram-notify.mjs) when it is not running; ends by itself after IDLE_HOURS
// without a notification. One daemon for all sessions: a bot can be asked by one process only.

import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { API, loadConfig, ensureData, paths, readJsonl, daemonPid } from './telegram-lib.mjs';

const { token: TOKEN, chat: CHAT } = loadConfig();

const POLL_SECONDS = Number(process.env.TELEGRAM_NOTIFY_POLL ?? 25);
const IDLE_HOURS = Number(process.env.TELEGRAM_NOTIFY_IDLE_HOURS ?? 12);
const KEEP_DAYS = 7;
const QUOTE = 160;

if (!TOKEN || !CHAT) {
    process.exit(0);
}

ensureData();

// One daemon at a time.
if (daemonPid() && daemonPid() !== process.pid) {
    process.exit(0);
}

writeFileSync(paths.pid, String(process.pid));

const cleanup = () => {
    try {
        if (parseInt(readFileSync(paths.pid, 'utf8'), 10) === process.pid) unlinkSync(paths.pid);
    } catch {
        // already gone
    }
};

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const log = (line) => {
    try {
        appendFileSync(paths.log, `${new Date().toISOString()} ${line}\n`);
    } catch {
        // a log is not worth a crash
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, params = {}, seconds = 15) {
    const response = await fetch(`${API}/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(seconds * 1000),
    });

    const json = await response.json().catch(() => ({}));

    if (!json.ok) {
        const error = new Error(json.description || `HTTP ${response.status}`);
        error.code = json.error_code ?? response.status;
        throw error;
    }

    return json.result;
}

// ---------- the table of sent notifications ----------

function routes() {
    return readJsonl(paths.routes);
}

// A week of routes is plenty: a reply to an older notification goes to the latest session.
function pruneRoutes() {
    const since = Date.now() - KEEP_DAYS * 86400000;
    const rows = routes();
    const fresh = rows.filter((row) => Date.parse(row.at) >= since);

    if (fresh.length !== rows.length) {
        writeFileSync(paths.routes, fresh.map((row) => JSON.stringify(row)).join('\n') + (fresh.length ? '\n' : ''));
    }
}

const latestRoute = (rows) => rows.reduce((best, row) => (!best || Date.parse(row.at) >= Date.parse(best.at) ? row : best), null);

// ---------- one message ----------

async function react(message, emoji) {
    try {
        await call('setMessageReaction', { chat_id: message.chat.id, message_id: message.message_id, reaction: [{ type: 'emoji', emoji }] });
    } catch {
        // a reaction is a courtesy
    }
}

let lastNotice = 0;

// Told to the owner, at most once in a minute.
async function tell(message, text) {
    if (Date.now() - lastNotice < 60000) return;

    lastNotice = Date.now();

    try {
        await call('sendMessage', { chat_id: message.chat.id, text, reply_to_message_id: message.message_id });
    } catch {
        // nobody to tell
    }
}

async function handle(update) {
    const message = update.message;

    if (!message || String(message.chat?.id) !== String(CHAT) || String(message.from?.id) !== String(CHAT)) {
        if (message) log(`ignored a message from ${message.from?.id} in ${message.chat?.id}`);

        return;
    }

    const text = (message.text ?? message.caption ?? '').trim();

    if (text === '') {
        await tell(message, 'Пока принимаю только текст.');

        return;
    }

    const rows = routes();
    const replied = message.reply_to_message;
    const route = (replied && rows.find((row) => row.message_id === replied.message_id)) || latestRoute(rows);

    if (!route) {
        await tell(message, 'Нет сессии, которой это можно передать: ответ придёт после следующего уведомления.');

        return;
    }

    const quote = replied ? String(replied.text ?? replied.caption ?? route.text ?? '').replace(/\s+/g, ' ').slice(0, QUOTE) : '';

    appendFileSync(paths.inbox(route.session_id), JSON.stringify({
        id: update.update_id,
        at: new Date((message.date ?? Date.now() / 1000) * 1000).toISOString(),
        text,
        quote,
        reply: Boolean(replied),
        project: route.project ?? '',
    }) + '\n');

    log(`message ${update.update_id} -> session ${route.session_id}${replied ? ' (reply)' : ''}`);

    await react(message, '👀');
}

// ---------- the loop ----------

function savedOffset() {
    try {
        return JSON.parse(readFileSync(paths.offset, 'utf8')).offset ?? null;
    } catch {
        return null;
    }
}

async function main() {
    log(`started, pid ${process.pid}`);
    pruneRoutes();

    let offset = savedOffset();

    // First start: what was written before is old news, not an instruction.
    if (offset === null) {
        try {
            const last = await call('getUpdates', { offset: -1, timeout: 0 });
            offset = last.length ? last[last.length - 1].update_id + 1 : 0;
        } catch (error) {
            log(`first look failed: ${error.message}`);
            offset = 0;
        }

        writeFileSync(paths.offset, JSON.stringify({ offset }));
    }

    for (;;) {
        const newest = latestRoute(routes());

        if (!newest || Date.now() - Date.parse(newest.at) > IDLE_HOURS * 3600000) {
            log('idle, ends');

            return;
        }

        let updates;

        try {
            updates = await call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] }, POLL_SECONDS + 15);
        } catch (error) {
            // 409: another process asks this bot (a webhook, another poller): wait, it may pass.
            log(`getUpdates failed: ${error.message}`);
            await sleep(error.code === 409 ? 30000 : 5000);

            continue;
        }

        for (const update of updates) {
            try {
                await handle(update);
            } catch (error) {
                log(`message ${update.update_id} failed: ${error.message}`);
            }

            offset = update.update_id + 1;
            writeFileSync(paths.offset, JSON.stringify({ offset }));
        }
    }
}

await main();
