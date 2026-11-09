// Журнал лаунчера на диске: <папка игры>/logs/launcher.log
// Сюда пишется всё подробно (источники, ответы серверов, железо, команда запуска, ошибки интерфейса),
// чтобы потом можно было открыть файл и понять, где сломалось. Прошлый запуск — launcher.old.log.
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');
const { ROOT } = require('./env');

const DIR = path.join(ROOT, 'logs');
const FILE = path.join(DIR, 'launcher.log');
const OLD = path.join(DIR, 'launcher.old.log');
const MAX = 8 * 1048576;     // 8 МБ, дальше начинаем новый файл

let stream = null, written = 0;

function open() {
    if (stream) return;
    try {
        fs.mkdirSync(DIR, { recursive: true });
        try { fs.renameSync(FILE, OLD); } catch {}
        stream = fs.createWriteStream(FILE, { flags: 'w' });
        stream.on('error', () => { stream = null; });
        written = 0;
    } catch { stream = null; }
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
function stamp() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function write(level, args) {
    const text = args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 160 }))).join(' ');
    const lines = text.split(/\r?\n/).map(l => `[${stamp()}] [${level}] ${l}`).join('\n') + '\n';
    if (process.env.PVL_LOG_STDOUT !== '0') {
        try { (level === 'ERROR' ? process.stderr : process.stdout).write(lines); } catch {}
    }
    open();
    if (!stream) return;
    if (written > MAX) {
        try { stream.end(); } catch {}
        stream = null;
        open();
        if (!stream) return;
    }
    written += lines.length;
    stream.write(lines);
}

module.exports = {
    FILE, DIR,
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
    ui: (...a) => write('UI', a),        // что видел игрок в журнале лаунчера
    game: (...a) => write('GAME', a),    // вывод самой игры
    close: () => { try { stream && stream.end(); } catch {} stream = null; }
};
