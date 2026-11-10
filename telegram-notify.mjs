// Stop hook: when Claude finishes a reply, ping the owner in Telegram with
// the start of that reply (formatted), when it started and ended, the model,
// the tokens and what they cost at API list prices.
// Setup: see README.md (token and chat id come from the environment or telegram-notify.env).

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { API, loadConfig, ensureData, paths, daemonRunning } from './telegram-lib.mjs';

// Chat-bot mode: while this file exists, terminal replies are not forwarded to Telegram.
if (existsSync(join(homedir(), '.claude', 'telegram-notify.paused'))) {
    process.exit(0);
}

const { token: TOKEN, chat: CHAT_ID } = loadConfig();
// The reply is sent whole. TELEGRAM_NOTIFY_MAX_CHARS=N cuts it at N characters (0: no cut).
const MAX = Number(process.env.TELEGRAM_NOTIFY_MAX_CHARS ?? 0);

// Telegram refuses a message over 4096 characters: longer ones go as several, cut at this size.
const LIMIT = 3900;

// USD per 1M tokens: [input, output, cache read]. API list prices (2026-11-03); a cache write costs
// 1.25x the input price for 5 minutes, 2x for 1 hour. A subscription is not billed this way: this is "what it would cost".
const PRICES = {
    'claude-fable-5-2': [8, 40, 0.2],
    'claude-mythos-5-2': [8, 40, 0.2],
    'claude-fable-5-1': [10, 50, 1],
    'claude-mythos-5-1': [10, 50, 1],
    'claude-fable-5': [10, 50, 1],
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-opus-5': [5, 25, 0.5],
    'claude-opus-4-8': [5, 25, 0.5],
    'claude-opus-4-7': [5, 25, 0.5],
    'claude-opus-4-6': [5, 25, 0.5],
    'claude-sonnet-5-5': [2, 10, 0.1],
    'claude-sonnet-5': [2, 10, 0.2],
    'claude-sonnet-4-6': [3, 15, 0.3],
    'claude-haiku-5-5': [0.1, 0.5, 0.01],
    'claude-haiku-4-5': [1, 5, 0.1],
};

const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

function readStdin() {
    try {
        return readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function textOf(message) {
    const content = message?.content;

    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
}

function readRows(input) {
    if (!input.transcript_path) {
        return [];
    }

    let lines;

    try {
        lines = readFileSync(input.transcript_path, 'utf8').split('\n');
    } catch {
        return [];
    }

    const rows = [];

    for (const line of lines) {
        if (line.trim() === '') continue;

        try {
            rows.push(JSON.parse(line));
        } catch {
            // a half-written last line
        }
    }

    return rows;
}

// ---------- numbers, money, time ----------

// Short number: 950, 12.3k, 1.4M.
function short(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

function money(usd) {
    if (usd >= 100) return '$' + usd.toFixed(0);
    if (usd >= 1) return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(3);
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayMonth = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
const sameDay = (a, b) => a.toDateString() === b.toDateString();

function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));

    if (s < 60) return `${s} с`;
    if (s < 3600) return `${Math.floor(s / 60)} мин ${s % 60} с`;

    return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}

// What one API call cost at list prices; null when the model is not in the table.
function costOf(model, usage) {
    const key = PRICE_KEYS.find((k) => model === k || String(model).startsWith(k + '-') || String(model).startsWith(k));

    if (!key) return null;

    const [inPrice, outPrice, readPrice] = PRICES[key];
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens ?? 0) - write1h);

    const usd =
        ((usage.input_tokens ?? 0) * inPrice +
            (usage.output_tokens ?? 0) * outPrice +
            (usage.cache_read_input_tokens ?? 0) * readPrice +
            write5m * inPrice * 1.25 +
            write1h * inPrice * 2) /
        1e6;

    // Fast mode is billed at twice the standard rate.
    return usage.speed === 'fast' ? usd * 2 : usd;
}

// ---------- tokens, cost and times of the transcript ----------

// This turn (since the user's last real message) and the whole session.
// One API message is written as several rows (one per block) with the same id: the last row wins.
function statsOf(input) {
    const rows = readRows(input);

    if (rows.length === 0) {
        return null;
    }

    const isPrompt = (row) => {
        if (row.type !== 'user' || row.isMeta || row.isSidechain) return false;
        const content = row.message?.content;
        if (typeof content === 'string') return content.trim() !== '';
        return Array.isArray(content) && content.some((block) => block?.type === 'text');
    };

    let turnStart = 0;

    rows.forEach((row, i) => {
        if (isPrompt(row)) turnStart = i;
    });

    const stamp = (row) => {
        const d = row?.timestamp ? new Date(row.timestamp) : null;
        return d && !Number.isNaN(d.getTime()) ? d : null;
    };

    const sum = (from) => {
        const byId = new Map();

        rows.slice(from).forEach((row, i) => {
            const usage = row.type === 'assistant' ? row.message?.usage : null;
            /* The client's own notes (a limit reached, an error) are not API calls. */
            if (!usage || row.message.model === '<synthetic>') return;
            byId.set(row.message.id ?? `row${from + i}`, { usage, model: row.message.model });
        });

        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: byId.size, usd: 0, unpriced: 0 };

        for (const { usage, model } of byId.values()) {
            total.input += usage.input_tokens ?? 0;
            total.output += usage.output_tokens ?? 0;
            total.cacheRead += usage.cache_read_input_tokens ?? 0;
            total.cacheWrite += usage.cache_creation_input_tokens ?? 0;

            const usd = costOf(model, usage);
            usd === null ? total.unpriced++ : (total.usd += usd);
        }

        return total;
    };

    // The model and the context size of the last reply of the main conversation.
    let model = '';
    let context = 0;

    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];

        if (row.type === 'assistant' && !row.isSidechain && row.message?.usage && row.message.model && row.message.model !== '<synthetic>') {
            const u = row.message.usage;
            model = row.message.model;
            context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            break;
        }
    }

    // When the turn began (the user's message) and ended (the last row of the transcript now).
    const turnBegan = stamp(rows[turnStart]);
    let turnEnded = null;

    for (let i = rows.length - 1; i >= turnStart; i--) {
        turnEnded = stamp(rows[i]);
        if (turnEnded) break;
    }

    const sessionBegan = rows.map(stamp).find(Boolean) ?? null;

    return { turn: sum(turnStart), session: sum(0), model, context, turnBegan, turnEnded, sessionBegan };
}

// The footer in two forms: Telegram HTML and plain text (when Telegram refuses the markup).
function footer(input) {
    let stats;

    try {
        stats = statsOf(input);
    } catch {
        return null;
    }

    if (!stats || (stats.turn.calls === 0 && stats.session.calls === 0)) {
        return null;
    }

    const cost = (t) => (t.unpriced > 0 ? (t.usd > 0 ? `≈${money(t.usd)}+?` : 'цена ?') : `≈${money(t.usd)}`);
    const tokens = (t) => `вх ${short(t.input)} · вых ${short(t.output)} · кэш ${short(t.cacheRead)} / ${short(t.cacheWrite)}`;

    const rowsOut = [];

    if (stats.turnBegan && stats.turnEnded) {
        const day = sameDay(stats.turnBegan, stats.turnEnded) ? '' : `${dayMonth(stats.turnBegan)} `;
        rowsOut.push(['Время', `${day}${clock(stats.turnBegan)} → ${clock(stats.turnEnded)} · ${duration(stats.turnEnded - stats.turnBegan)}`]);
    }

    rowsOut.push(['Модель', `${stats.model || 'неизвестна'}${stats.context ? ` · контекст ${short(stats.context)}` : ''}`]);
    rowsOut.push(['Ответ', `${cost(stats.turn)} · ${stats.turn.calls} выз. · ${tokens(stats.turn)}`]);

    const since = stats.sessionBegan
        ? `с ${sameDay(stats.sessionBegan, new Date()) ? '' : dayMonth(stats.sessionBegan) + ' '}${pad(stats.sessionBegan.getHours())}:${pad(stats.sessionBegan.getMinutes())} · `
        : '';
    rowsOut.push(['Сессия', `${since}${cost(stats.session)} · ${stats.session.calls} выз. · ${tokens(stats.session)}`]);

    return {
        html: '<blockquote>' + rowsOut.map(([label, value]) => `<b>${label}</b>  ${escapeHtml(value)}`).join('\n') + '</blockquote>',
        plain: rowsOut.map(([label, value]) => `${label}: ${value}`).join('\n'),
    };
}

// ---------- the reply: Markdown to Telegram HTML ----------

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One line of prose: `code`, **bold**, [text](url), "- " bullets, # headings.
function inline(line) {
    return line
        .split(/(`[^`\n]+`)/)
        .map((part, i) => {
            if (i % 2 === 1) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }

            let text = escapeHtml(part);

            text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
            text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, '%22')}">${label}</a>`);

            return text;
        })
        .join('');
}

// Every tag it makes is closed within its own line or code block, so a cut between blocks never breaks one.
function toBlocks(markdown) {
    const out = [];
    const pieces = markdown.split(/```[^\n]*\n?/);

    pieces.forEach((piece, index) => {
        // Odd pieces are inside a fence (an unclosed one, after the cut, counts too).
        if (index % 2 === 1) {
            const code = piece.replace(/\n+$/, '');
            if (code !== '') out.push(`<pre>${escapeHtml(code)}</pre>`);
            return;
        }

        let table = [];

        const flush = () => {
            if (table.length > 0) out.push(`<pre>${escapeHtml(table.join('\n'))}</pre>`);
            table = [];
        };

        for (const line of piece.split('\n')) {
            if (/^\s*\|/.test(line)) {
                // The |---|---| row of a table says nothing.
                if (!/^\s*\|[\s:|-]+\|?\s*$/.test(line)) table.push(line.trim());
                continue;
            }

            flush();

            const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
            const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);

            if (heading) {
                out.push(`<b>${inline(heading[1].replace(/\*\*/g, ''))}</b>`);
            } else if (bullet) {
                out.push(`${bullet[1]}• ${inline(bullet[2])}`);
            } else {
                out.push(inline(line));
            }
        }

        flush();
    });

    return out;
}

// The text of a chunk without its markup: what is sent when Telegram refuses the HTML.
function stripTags(html) {
    return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Cuts a long text at a line break, else at a space outside any tag, else hard (not inside an entity or a tag).
function cutAt(text, size) {
    if (text.length <= size) {
        return [text, ''];
    }

    const head = text.slice(0, size);
    let at = head.lastIndexOf('\n');

    if (at < size / 2) {
        at = -1;

        for (let i = 0, depth = 0; i < head.length; i++) {
            if (head[i] === '<') depth = head.startsWith('</', i) ? depth - 1 : depth + 1;
            if (head[i] === ' ' && depth <= 0) at = i;
        }
    }

    if (at < size / 2) {
        at = size;

        const open = Math.max(head.lastIndexOf('&'), head.lastIndexOf('<'));

        if (open > head.lastIndexOf(';') && open > head.lastIndexOf('>')) at = open;
    }

    return [text.slice(0, at), text.slice(at).replace(/^\n/, '')];
}

// A block longer than a message: a code block is cut into code blocks, anything else at spaces.
function splitBlock(block, size) {
    if (block.length <= size) {
        return [block];
    }

    const pre = block.startsWith('<pre>') && block.endsWith('</pre>');
    const pieces = [];
    let rest = pre ? block.slice(5, -6) : block;

    while (rest !== '') {
        const [piece, left] = cutAt(rest, pre ? size - 11 : size);
        pieces.push(pre ? `<pre>${piece}</pre>` : piece);
        rest = left;
    }

    return pieces;
}

// Messages of at most `size` characters, cut between blocks.
function chunks(blocks, size = LIMIT) {
    const parts = [];
    let current = '';

    const flush = () => {
        const text = current.replace(/\n{3,}/g, '\n\n').trim();
        if (text !== '') parts.push(text);
        current = '';
    };

    for (const block of blocks.flatMap((b) => splitBlock(b, size))) {
        if (current !== '' && current.length + block.length + 1 > size) flush();
        current += (current === '' ? '' : '\n') + block;
    }

    flush();

    return parts;
}

// The last reply of the main conversation: the hook's own field when there is one, else the transcript.
function lastReply(input, rows) {
    if (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() !== '') {
        return input.last_assistant_message.trim();
    }

    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];

        if (row.type !== 'assistant' || row.isSidechain) {
            continue;
        }

        const text = textOf(row.message);

        if (text !== '') {
            return text;
        }
    }

    return '';
}

async function send(payload, retried = false) {
    const response = await fetch(`${API}/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, link_preview_options: { is_disabled: true }, ...payload }),
        signal: AbortSignal.timeout(10000),
    });

    const text = await response.text();
    let json = null;

    try {
        json = JSON.parse(text);
    } catch {
        // not JSON: the status says enough
    }

    /* Too many messages at once: Telegram says how long to wait; once is enough. */
    if (response.status === 429 && !retried) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, json?.parameters?.retry_after ?? 3) * 1000));

        return send(payload, true);
    }

    return { status: response.status, body: text.slice(0, 160), json };
}

// A reply to this message goes to this session: the inbox daemon (telegram-inbox.mjs) reads this table.
// TELEGRAM_NOTIFY_INBOX=off: no replies from Telegram.
function rememberRoute(input, project, reply, result) {
    const messageId = result?.json?.result?.message_id;

    if (process.env.TELEGRAM_NOTIFY_INBOX === 'off' || !messageId || !input.session_id) {
        return;
    }

    try {
        ensureData();
        appendFileSync(paths.routes, JSON.stringify({ message_id: messageId, session_id: input.session_id, project, at: new Date().toISOString(), text: reply.slice(0, 160) }) + '\n');

        if (!daemonRunning()) {
            const daemon = fileURLToPath(new URL('./telegram-inbox.mjs', import.meta.url));
            spawn(process.execPath, [daemon], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
    } catch {
        // the notification is sent; the reply channel is a bonus
    }
}

async function main() {
    let input = {};

    try {
        input = JSON.parse(readStdin() || '{}');
    } catch {
        input = {};
    }

    const project = input.cwd ? basename(input.cwd) : '';
    let reply = lastReply(input, readRows(input)).trim();

    if (MAX > 0 && reply.length > MAX) {
        reply = reply.slice(0, MAX).trimEnd() + '…';
    }

    reply = reply || 'Закончил ответ.';

    const foot = footer(input);
    const blocks = [project ? `<b>${escapeHtml(project)}</b>` : '', '', ...toBlocks(reply), '', foot?.html ?? ''];
    let parts = chunks(blocks);

    /* Several messages are numbered, so the order is clear on the phone. */
    if (parts.length > 1) {
        parts = parts.map((part, i) => (i === 0 ? part : `<i>${i + 1}/${parts.length}</i>\n${part}`));
        parts[0] = `${parts[0]}\n<i>1/${parts.length}</i>`;
    }

    /* TG_NOTIFY_DRY=1: only show what would be sent. */
    if (process.env.TG_NOTIFY_DRY) {
        parts.forEach((part, i) => console.log(`${i > 0 ? '\n' : ''}--- message ${i + 1} of ${parts.length}, ${part.length} characters ---\n${part}`));
        console.log(`\n--- token and chat id: ${TOKEN && CHAT_ID ? 'found' : 'MISSING'} ---`);

        return;
    }

    /* No token or chat id: nothing to send to, and a hook must never fail the session. */
    if (!TOKEN || !CHAT_ID) {
        if (process.env.TG_NOTIFY_DEBUG) {
            console.log('no token or chat id: set TELEGRAM_NOTIFY_TOKEN and TELEGRAM_NOTIFY_CHAT_ID (or the env file)');
        }

        return;
    }

    for (const part of parts) {
        try {
            let result = await send({ text: part, parse_mode: 'HTML' });

            /* Telegram refused the markup: the same piece as plain text, nothing is lost. */
            if (result.status === 400) {
                result = await send({ text: stripTags(part) });
            }

            /* A reply to any of the pieces goes to this session. */
            rememberRoute(input, project, reply, result);

            /* TG_NOTIFY_DEBUG=1: what was sent and what Telegram said, for checking by hand. */
            if (process.env.TG_NOTIFY_DEBUG) {
                console.log(part);
                console.log('---', result.status, result.body);
            }
        } catch (error) {
            if (process.env.TG_NOTIFY_DEBUG) {
                console.log('failed:', error?.message);
            }
        }
    }
}

await main();
