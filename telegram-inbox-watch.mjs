// Run by a Claude Code session through its Monitor tool:
//
//   node telegram-inbox-watch.mjs <session_id>
//
// Prints one line for every message the owner wrote in Telegram for this session. Each line reaches the
// agent as an event, as if it were typed in the terminal. While nothing is written it prints nothing and
// costs nothing. Whatever arrived before it was started is printed first, once.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { ensureData, paths } from './telegram-lib.mjs';

const session = process.argv[2];

if (!session) {
    console.error('usage: node telegram-inbox-watch.mjs <session_id>');
    process.exit(2);
}

ensureData();

const inbox = paths.inbox(session);
const positionFile = paths.position(session);

function position() {
    try {
        return parseInt(readFileSync(positionFile, 'utf8'), 10) || 0;
    } catch {
        return 0;
    }
}

// One line: what the agent reads.
function line(row) {
    const text = String(row.text).replace(/\s*\n\s*/g, ' ⏎ ');
    const where = row.project ? ` (${row.project})` : '';

    return row.reply && row.quote
        ? `[Telegram${where}, реплай на «${row.quote}»] ${text}`
        : `[Telegram${where}] ${text}`;
}

function look() {
    if (!existsSync(inbox)) {
        return;
    }

    const from = position();
    const size = statSync(inbox).size;

    if (size <= from) {
        return;
    }

    const chunk = readFileSync(inbox).subarray(from).toString('utf8');
    const end = chunk.lastIndexOf('\n');

    // Only whole lines.
    if (end < 0) {
        return;
    }

    for (const raw of chunk.slice(0, end).split('\n')) {
        try {
            process.stdout.write(line(JSON.parse(raw)) + '\n');
        } catch {
            // not a message
        }
    }

    writeFileSync(positionFile, String(from + Buffer.byteLength(chunk.slice(0, end + 1))));
}

look();
setInterval(look, 1000);
