// Shared by the hook (telegram-notify.mjs), the inbox daemon (telegram-inbox.mjs), the session
// watcher (telegram-inbox-watch.mjs) and the session hint (telegram-inbox-hint.mjs).

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Where the daemon keeps its tables and the inbox of every session.
export const DATA = process.env.TELEGRAM_NOTIFY_DATA || join(homedir(), '.claude', 'telegram-inbox');

// Telegram's address; another one only for tests.
export const API = process.env.TELEGRAM_NOTIFY_API || 'https://api.telegram.org';

// A session id as a file name.
export const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

export const paths = {
    routes: join(DATA, 'routes.jsonl'),
    offset: join(DATA, 'offset.json'),
    pid: join(DATA, 'daemon.pid'),
    log: join(DATA, 'daemon.log'),
    inbox: (session) => join(DATA, 'inbox', `${safe(session)}.jsonl`),
    position: (session) => join(DATA, 'inbox', `${safe(session)}.pos`),
};

export function ensureData() {
    mkdirSync(join(DATA, 'inbox'), { recursive: true });
}

// The bot token and the chat id: TELEGRAM_NOTIFY_TOKEN / TELEGRAM_NOTIFY_CHAT_ID from the environment, else from
// a KEY=VALUE file (TELEGRAM_NOTIFY_ENV, default ~/.claude/telegram-notify.env). Never written in a script.
export function loadConfig() {
    const config = { token: process.env.TELEGRAM_NOTIFY_TOKEN ?? '', chat: process.env.TELEGRAM_NOTIFY_CHAT_ID ?? '' };
    const file = process.env.TELEGRAM_NOTIFY_ENV || join(homedir(), '.claude', 'telegram-notify.env');

    if ((!config.token || !config.chat) && existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
            const match = /^\s*(?:export\s+)?(TELEGRAM_NOTIFY_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);

            if (!match) continue;

            const value = match[2].replace(/^(['"])(.*)\1$/, '$2');

            if (match[1] === 'TELEGRAM_NOTIFY_TOKEN' && !config.token) config.token = value;
            if (match[1] === 'TELEGRAM_NOTIFY_CHAT_ID' && !config.chat) config.chat = value;
        }
    }

    return config;
}

// The lines of a .jsonl file that parse; a half-written last line is left for the next look.
export function readJsonl(file) {
    if (!existsSync(file)) {
        return [];
    }

    const rows = [];

    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue;

        try {
            rows.push(JSON.parse(line));
        } catch {
            // not whole yet
        }
    }

    return rows;
}

export function alive(pid) {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// The daemon's pid when it runs, else 0.
export function daemonPid() {
    try {
        const pid = parseInt(readFileSync(paths.pid, 'utf8'), 10);

        return pid > 0 && alive(pid) ? pid : 0;
    } catch {
        return 0;
    }
}

export const daemonRunning = () => daemonPid() > 0;
