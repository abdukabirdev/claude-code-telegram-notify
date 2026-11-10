// node --test
// The daemon and the watcher against a fake Telegram: nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 4242;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 6000) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        const value = check();
        if (value) return value;
        await sleep(100);
    }

    return check();
}

// A fake Telegram: getUpdates hands out what the test queued; every call is kept.
function fakeTelegram() {
    const state = { updates: [], calls: [] };

    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            const method = req.url.split('/').pop();
            const params = JSON.parse(body || '{}');
            state.calls.push({ method, params });

            let result = true;

            if (method === 'getUpdates') {
                if (params.offset === -1) {
                    result = [];
                } else {
                    result = state.updates.filter((u) => u.update_id >= (params.offset ?? 0));
                    if (result.length === 0) await sleep(200);
                }
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, result }));
        });
    });

    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` })));
}

const message = (id, text, extra = {}, from = OWNER) => ({
    update_id: id,
    message: { message_id: 1000 + id, date: 1_800_000_000, chat: { id: from }, from: { id: from }, text, ...extra },
});

test('a reply goes to the session that sent the notification, the rest to the latest one, strangers nowhere', async () => {
    const telegram = await fakeTelegram();
    const data = mkdtempSync(join(tmpdir(), 'tgnotify-'));
    mkdirSync(join(data, 'inbox'), { recursive: true });

    const now = Date.now();
    const route = (message_id, session_id, project, ago) => JSON.stringify({ message_id, session_id, project, at: new Date(now - ago).toISOString(), text: `note ${message_id}` });

    writeFileSync(join(data, 'routes.jsonl'), [
        route(11, 'session-a', 'alpha', 3000),
        route(22, 'session-b', 'beta', 1000),
    ].join('\n') + '\n');

    const env = {
        ...process.env,
        TELEGRAM_NOTIFY_TOKEN: '1:test',
        TELEGRAM_NOTIFY_CHAT_ID: String(OWNER),
        TELEGRAM_NOTIFY_API: telegram.url,
        TELEGRAM_NOTIFY_DATA: data,
        TELEGRAM_NOTIFY_POLL: '1',
    };

    // A reply to the notification of session A; a plain message; a stranger; a reply to an unknown message; a photo.
    telegram.state.updates.push(
        message(1, 'first, to A', { reply_to_message: { message_id: 11, text: 'note 11 and the rest' } }),
        message(2, 'second, no reply'),
        message(3, 'stranger', {}, 999),
        message(4, 'to an old one', { reply_to_message: { message_id: 7, text: 'gone' } }),
        { update_id: 5, message: { message_id: 1005, chat: { id: OWNER }, from: { id: OWNER }, photo: [{}] } },
    );

    const daemon = spawn(process.execPath, [join(root, 'telegram-inbox.mjs')], { env, stdio: 'ignore' });

    try {
        const inboxB = join(data, 'inbox', 'session-b.jsonl');
        await until(() => existsSync(inboxB) && readFileSync(inboxB, 'utf8').trim().split('\n').length >= 2);

        const rows = (session) => {
            const file = join(data, 'inbox', `${session}.jsonl`);
            return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
        };

        const a = rows('session-a');
        const b = rows('session-b');

        assert.deepEqual(a.map((r) => r.text), ['first, to A']);
        assert.equal(a[0].reply, true);
        assert.equal(a[0].quote, 'note 11 and the rest');
        assert.equal(a[0].project, 'alpha');
        assert.deepEqual(b.map((r) => r.text), ['second, no reply', 'to an old one']);
        assert.equal(b[0].reply, false);

        // Seen: a reaction under each accepted message; the photo is answered; the stranger gets nothing.
        const reactions = () => telegram.state.calls.filter((c) => c.method === 'setMessageReaction').map((c) => c.params.message_id).sort();
        await until(() => reactions().length >= 3 && telegram.state.calls.some((c) => c.method === 'sendMessage'));
        assert.deepEqual(reactions(), [1001, 1002, 1004]);
        assert.ok(telegram.state.calls.some((c) => c.method === 'sendMessage' && /текст/.test(c.params.text)));
        assert.ok(!telegram.state.calls.some((c) => JSON.stringify(c.params).includes('stranger')));
        assert.ok(!existsSync(join(data, 'inbox', 'session-999.jsonl')));

        // The offset is kept: a restart does not deliver the same messages again.
        assert.equal(JSON.parse(readFileSync(join(data, 'offset.json'), 'utf8')).offset, 6);

        // The watcher prints the session's lines once, as one line each, and not the other session's.
        const watcher = spawn(process.execPath, [join(root, 'telegram-inbox-watch.mjs'), 'session-a'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        watcher.stdout.on('data', (chunk) => (out += chunk));

        await until(() => out.includes('\n'));
        assert.equal(out, '[Telegram (alpha), реплай на «note 11 and the rest»] first, to A\n');

        // A message that arrives later is printed as it comes, a multi-line one on one line.
        appendFileSync(join(data, 'inbox', 'session-a.jsonl'), JSON.stringify({ id: 9, at: 'x', text: 'one\ntwo', quote: '', reply: false, project: 'alpha' }) + '\n');
        await until(() => out.split('\n').length > 2);
        assert.equal(out.split('\n')[1], '[Telegram (alpha)] one ⏎ two');

        watcher.kill();
    } finally {
        daemon.kill();
        telegram.server.close();
    }
});

test('the first start skips what was written before it', async () => {
    const telegram = await fakeTelegram();
    const data = mkdtempSync(join(tmpdir(), 'tgnotify-'));
    mkdirSync(join(data, 'inbox'), { recursive: true });
    writeFileSync(join(data, 'routes.jsonl'), JSON.stringify({ message_id: 1, session_id: 's', project: 'p', at: new Date().toISOString(), text: 'n' }) + '\n');

    // The fake answers offset -1 with an empty list, so the backlog is seen as nothing to skip; what matters here is
    // that the daemon starts, writes its pid and its offset, and ends cleanly when asked.
    const env = { ...process.env, TELEGRAM_NOTIFY_TOKEN: '1:t', TELEGRAM_NOTIFY_CHAT_ID: String(OWNER), TELEGRAM_NOTIFY_API: telegram.url, TELEGRAM_NOTIFY_DATA: data, TELEGRAM_NOTIFY_POLL: '1' };
    const daemon = spawn(process.execPath, [join(root, 'telegram-inbox.mjs')], { env, stdio: 'ignore' });

    try {
        await until(() => existsSync(join(data, 'offset.json')) && existsSync(join(data, 'daemon.pid')));
        assert.equal(parseInt(readFileSync(join(data, 'daemon.pid'), 'utf8'), 10), daemon.pid);

        // A second daemon does not start.
        const second = spawn(process.execPath, [join(root, 'telegram-inbox.mjs')], { env, stdio: 'ignore' });
        const code = await new Promise((resolve) => second.on('exit', resolve));
        assert.equal(code, 0);
        assert.equal(parseInt(readFileSync(join(data, 'daemon.pid'), 'utf8'), 10), daemon.pid);
    } finally {
        daemon.kill();
        telegram.server.close();
    }
});

test('without a token nothing starts and nothing fails', async () => {
    const data = mkdtempSync(join(tmpdir(), 'tgnotify-'));
    const env = { ...process.env, TELEGRAM_NOTIFY_TOKEN: '', TELEGRAM_NOTIFY_CHAT_ID: '', TELEGRAM_NOTIFY_ENV: join(data, 'none.env'), TELEGRAM_NOTIFY_DATA: data };
    const daemon = spawn(process.execPath, [join(root, 'telegram-inbox.mjs')], { env, stdio: 'ignore' });

    assert.equal(await new Promise((resolve) => daemon.on('exit', resolve)), 0);
    assert.ok(!existsSync(join(data, 'daemon.pid')));
});
