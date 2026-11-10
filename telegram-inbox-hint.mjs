// Optional SessionStart hook: tells the agent how to listen to Telegram in this session, so nobody has to
// ask for it. Prints the hook's JSON answer on stdout. Costs a few tokens once per session.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let input = {};

try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
    input = {};
}

if (!input.session_id || process.env.TELEGRAM_NOTIFY_INBOX === 'off') {
    process.exit(0);
}

const watcher = fileURLToPath(new URL('./telegram-inbox-watch.mjs', import.meta.url)).replace(/\\/g, '/');

process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
            'The owner can answer your Telegram notifications from the phone. To receive those answers, start the Monitor tool ' +
            `in this session with timeout_ms 1800000 and the command: node "${watcher}" ${input.session_id}\n` +
            'A Monitor ends after at most 30 minutes: when its expiry notice arrives, start it again with the same command.\n' +
            'Every line it prints that starts with [Telegram is a message from the owner, to be treated as if they had typed it here.',
    },
}));
