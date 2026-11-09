// Сеть: скачивание файлов с проверкой, надёжная загрузка архивов сборки
// (докачка, проверка zip, несколько источников, Яндекс Диск / Google Drive / части архива).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { ROOT, UA } = require('./env');

function fileSizeOk(filePath, size) {
    try {
        const st = fs.statSync(filePath);
        return st.isFile() && (!size || st.size === size);
    } catch { return false; }
}

// Скачивание файла с проверкой sha1/sha256, через .part и до 3 попыток
async function downloadFile(url, dest, { sha1, sha256, onData, timeout = 60000 } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await axios.get(url, {
                responseType: 'stream',
                timeout,
                maxRedirects: 10,
                headers: { 'User-Agent': 'PVL-Launcher/1.0' }
            });
            const expected = (sha256 || sha1 || '').toLowerCase();
            const hash = crypto.createHash(sha256 ? 'sha256' : 'sha1');
            const writer = fs.createWriteStream(tmp);
            await new Promise((resolve, reject) => {
                res.data.on('data', (chunk) => { hash.update(chunk); if (onData) onData(chunk.length, res); });
                res.data.on('error', reject);
                writer.on('error', reject);
                writer.on('finish', resolve);
                res.data.pipe(writer);
            });
            const got = hash.digest('hex');
            if (expected && got !== expected) throw new Error(`Контрольная сумма не совпала: ${path.basename(dest)}`);
            fs.renameSync(tmp, dest);
            return;
        } catch (e) {
            lastErr = e;
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        }
    }
    throw new Error(`Не удалось скачать ${url}: ${lastErr && lastErr.message}`);
}

// Параллельная обработка с ограничением
async function runPool(items, limit, worker, onProgress) {
    let index = 0, done = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await worker(item);
            done++;
            if (onProgress) onProgress(done, items.length);
        }
    });
    await Promise.all(runners);
}

// Dropbox: dl=0 открывает страницу предпросмотра, для скачивания нужен dl=1
function directUrl(url) {
    if (!/dropbox\.com/.test(url)) return url;
    if (/[?&]dl=\d/.test(url)) return url.replace(/([?&])dl=\d/, '$1dl=1');
    return url + (url.includes('?') ? '&' : '?') + 'dl=1';
}

// Ключ для сравнения ссылок без случайного параметра st=
function urlKey(url) {
    return directUrl(url).replace(/([?&])st=[^&]*&?/, '$1').replace(/[?&]$/, '');
}

function isYandexDisk(url) {
    return /^https:\/\/(disk\.yandex\.[a-z]+|yadi\.sk)\//i.test(url);
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'источник'; }
}

// Превращаем ссылку «для людей» в прямую ссылку на файл
async function resolveDownloadUrl(url) {
    if (isYandexDisk(url)) {
        const r = await axios.get('https://cloud-api.yandex.net/v1/disk/public/resources/download',
            { params: { public_key: url }, timeout: 15000 });
        if (!r.data || !r.data.href) throw dlError('http', 'Яндекс Диск не выдал ссылку на файл');
        return r.data.href;
    }
    const gd = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([\w-]+)/);
    if (gd) return `https://drive.usercontent.google.com/download?id=${gd[1]}&export=download&confirm=t`;
    return directUrl(url);
}

function dlError(kind, message, extra = {}) {
    const e = new Error(message);
    e.kind = kind;   // network | html | http | corrupt | space | changed
    Object.assign(e, extra);
    return e;
}

function readJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function freeSpace(dir) {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

// Целый ли zip: в начале «PK», в конце — запись End Of Central Directory
function checkZip(file) {
    const size = fs.statSync(file).size;
    if (size < 22) return 'файл слишком маленький';
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        if (head[0] === 0x3c) return 'вместо архива скачалась веб-страница';
        if (head[0] !== 0x50 || head[1] !== 0x4b) return 'это не zip-архив';
        const len = Math.min(size, 65557);
        const tail = Buffer.alloc(len);
        fs.readSync(fd, tail, 0, len, size - len);
        for (let i = len - 22; i >= 0; i--) {
            if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) return null;
        }
        return 'архив скачался не до конца';
    } finally {
        fs.closeSync(fd);
    }
}

const fmtMB = (b) => (b / 1048576).toFixed(0);

// Одна попытка: качаем в .part, продолжая с места обрыва
async function fetchToPart(sourceUrl, part, r, label) {
    const metaPath = part + '.json';
    const key = urlKey(sourceUrl);
    let meta = readJsonSafe(metaPath);
    let start = 0;
    if (meta && meta.key === key && fs.existsSync(part)) start = fs.statSync(part).size;
    else { try { fs.unlinkSync(part); } catch {} meta = null; }

    const t0 = Date.now();
    r.log(`>   ЗАПРОС [${label}]: ${sourceUrl}${start > 0 ? ` (докачка с ${fmtMB(start)} МБ)` : ''}`);
    const url = await resolveDownloadUrl(sourceUrl);
    if (url !== sourceUrl) r.log(`>   ПРЯМАЯ ССЫЛКА: ${url.length > 220 ? url.slice(0, 220) + '…' : url}`);
    const headers = { 'User-Agent': UA };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const res = await axios.get(url, {
        responseType: 'stream', maxRedirects: 10, timeout: 30000, headers,
        validateStatus: () => true
    });
    const status = res.status;
    const ctype = String(res.headers['content-type'] || '');
    const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || url;
    r.log(`>   ОТВЕТ: HTTP ${status} · ${ctype || 'без типа'} · длина ${res.headers['content-length'] || '?'}`
        + `${res.headers['content-range'] ? ' · ' + res.headers['content-range'] : ''} · сервер ${hostOf(finalUrl)} · ${Date.now() - t0} мс`);

    if (status === 416 && start > 0 && meta && meta.total === start) { res.data.destroy(); return; } // уже докачан
    if (status === 416) { res.data.destroy(); try { fs.unlinkSync(part); } catch {} throw dlError('changed', 'начинаю заново'); }
    if (status >= 400) {
        res.data.destroy();
        throw dlError(status >= 500 ? 'network' : 'http', `сервер ответил ошибкой ${status}`, { status });
    }
    if (/text\/html/i.test(ctype)) {
        res.data.destroy();
        throw dlError('html', 'вместо архива пришла веб-страница (ссылка отключена или заблокирована)');
    }

    let total, append;
    if (status === 206) {
        append = true;
        total = parseInt(String(res.headers['content-range'] || '').split('/')[1], 10) || null;
        if (meta && meta.total && total && meta.total !== total) {
            res.data.destroy(); try { fs.unlinkSync(part); } catch {}
            throw dlError('changed', 'архив на сервере обновился, начинаю заново');
        }
        r.log(`> ПРОДОЛЖАЮ С ${fmtMB(start)} МБ...`);
    } else {
        append = false; start = 0;
        const len = parseInt(res.headers['content-length'], 10);
        total = len > 0 ? len : null;
    }

    // Место: архив + распакованная сборка (~2.2 размера архива)
    if (total) {
        const need = (total - start) + total * 1.2;
        if (freeSpace(ROOT) < need) {
            res.data.destroy();
            throw dlError('space', `не хватает места на диске: нужно около ${Math.ceil(need / 1073741824)} ГБ свободных`);
        }
    }
    fs.writeFileSync(metaPath, JSON.stringify({ key, total }));

    const writer = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let got = start, lastUi = 0, idle;
    await new Promise((resolve, reject) => {
        const fail = (err) => { clearTimeout(idle); res.data.destroy(); writer.destroy(); reject(err); };
        const bump = () => {
            clearTimeout(idle);
            idle = setTimeout(() => fail(dlError('network', 'скачивание зависло — нет данных 45 секунд')), 45000);
        };
        bump();
        res.data.on('data', (chunk) => {
            got += chunk.length; bump();
            const now = Date.now();
            if (now - lastUi > 250) {
                lastUi = now;
                r.progress(got, total || got + 50 * 1048576);
                r.status(total ? `Скачиваю сборку · ${fmtMB(got)} из ${fmtMB(total)} МБ` : `Скачиваю сборку · ${fmtMB(got)} МБ`);
            }
        });
        res.data.on('error', (e) => fail(dlError('network', e.message || 'обрыв связи')));
        res.data.on('aborted', () => fail(dlError('network', 'обрыв связи')));
        writer.on('error', (e) => fail(e && e.code === 'ENOSPC'
            ? dlError('space', 'закончилось место на диске')
            : dlError('network', e.message)));
        writer.on('finish', () => { clearTimeout(idle); resolve(); });
        res.data.pipe(writer);
    });

    const sec = Math.max(0.001, (Date.now() - t0) / 1000);
    r.log(`>   ПОЛУЧЕНО ${fmtMB(got)}${total ? ' из ' + fmtMB(total) : ''} МБ за ${sec.toFixed(0)} с · `
        + `${((got - start) / 1048576 / sec).toFixed(1)} МБ/с`);
    if (total && got < total) throw dlError('network', `связь оборвалась на ${fmtMB(got)} из ${fmtMB(total)} МБ`);
}

// Одна ссылка с повторами (обрывы связи, зависания)
async function fetchWithRetry(url, file, r, label) {
    let restarts = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
        try {
            await fetchToPart(url, file, r, label);
            return;
        } catch (e) {
            const kind = e.kind || 'network';
            e.kind = kind;
            if (kind === 'changed') { attempt--; if (++restarts > 3) throw e; continue; }
            if (kind === 'space' || kind === 'html' || kind === 'http' || attempt === 6) {
                r.log(`>   ОШИБКА [${kind}${e.code ? ' ' + e.code : ''}${e.status ? ' HTTP ' + e.status : ''}]: ${e.message}`);
                throw e;
            }
            const wait = Math.min(30, 2 ** attempt);
            r.log(`>   ОШИБКА [${kind}${e.code ? ' ' + e.code : ''}]: ${e.message}`);
            r.log(`> ${e.message.toUpperCase()}. ПОВТОР ЧЕРЕЗ ${wait} С (${attempt}/5)...`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
}

async function concatFiles(files, out) {
    const { pipeline } = require('stream/promises');
    const w = fs.createWriteStream(out);
    for (const f of files) await pipeline(fs.createReadStream(f), w, { end: false });
    await new Promise((resolve, reject) => { w.on('error', reject); w.end(resolve); });
}

// Качаем со всех источников по очереди, с повторами и проверкой архива.
// sources: [{ urls: [ссылка] }] или [{ urls: [часть1, часть2, ...] }]
async function downloadArchive(sources, dest, r, label) {
    const part = dest + '.part';
    const reasons = [];
    try { fs.unlinkSync(dest); } catch {}
    sources = sources.map(s => (typeof s === 'string' ? { urls: [s] } : s));

    for (let si = 0; si < sources.length; si++) {
        const { urls } = sources[si];
        const host = hostOf(urls[0]);
        r.log(`> ИСТОЧНИК ${si + 1} ИЗ ${sources.length}: ${host}${urls.length > 1 ? ` (${urls.length} ЧАСТИ)` : ''}`);
        let corruptTries = 0;
        while (true) {
            try {
                if (urls.length === 1) {
                    await fetchWithRetry(urls[0], part, r, label);
                } else {
                    const pieces = [];
                    for (let k = 0; k < urls.length; k++) {
                        const piece = `${dest}.p${k + 1}`;
                        r.log(`> ЧАСТЬ ${k + 1} ИЗ ${urls.length}...`);
                        await fetchWithRetry(urls[k], piece, r, `${label} ${k + 1}/${urls.length}`);
                        pieces.push(piece);
                    }
                    r.log('> СКЛЕИВАЮ ЧАСТИ...');
                    try { fs.unlinkSync(part); } catch {}
                    await concatFiles(pieces, part);
                    for (const p of pieces) { try { fs.unlinkSync(p); fs.unlinkSync(p + '.json'); } catch {} }
                }
                const bad = checkZip(part);
                r.log(`>   ПРОВЕРКА АРХИВА (${fmtMB(fs.statSync(part).size)} МБ): ${bad || 'zip целый'}`);
                if (bad) {
                    try { fs.unlinkSync(part); fs.unlinkSync(part + '.json'); } catch {}
                    if (/веб-страница/.test(bad)) throw dlError('html', bad);
                    throw dlError('corrupt', bad);
                }
                fs.renameSync(part, dest);
                try { fs.unlinkSync(part + '.json'); } catch {}
                return;
            } catch (e) {
                const kind = e.kind || 'network';
                if (kind === 'space') throw new Error(`${e.message[0].toUpperCase()}${e.message.slice(1)}. Освободи место и нажми «Играть».`);
                if (kind === 'corrupt' && ++corruptTries <= 1) {
                    r.log(`> ${e.message.toUpperCase()}. СКАЧИВАЮ ЗАНОВО...`);
                    continue;
                }
                reasons.push({ host, kind, msg: e.message });
                break;
            }
        }
        r.log(`> НЕ УДАЛОСЬ СКАЧАТЬ С ${host.toUpperCase()}: ${reasons[reasons.length - 1].msg}`);
        if (si < sources.length - 1) r.log('> ПРОБУЮ ЗАПАСНОЙ ИСТОЧНИК...');
    }

    // Понятное объяснение для игрока
    r.log('> ИТОГ: НИ ОДИН ИСТОЧНИК НЕ ОТДАЛ АРХИВ:');
    for (const x of reasons) r.log(`>   ${x.host}: [${x.kind}] ${x.msg}`);
    const kinds = reasons.map(r => r.kind);
    if (kinds.every(k => k === 'html' || k === 'http')) {
        throw new Error('Хранилище сборки сейчас не отдаёт архив: ссылка временно отключена (лимит скачиваний) '
            + 'или заблокирована у твоего провайдера. Попробуй через час или включи VPN и нажми «Играть».');
    }
    if (kinds.includes('network')) {
        throw new Error('Скачивание постоянно обрывается — проверь интернет. Нажми «Играть» ещё раз: '
            + 'загрузка продолжится с того места, где остановилась.');
    }
    throw new Error('Архив сборки скачивается повреждённым. Попробуй позже или через VPN.');
}

module.exports = { fileSizeOk, downloadFile, runPool, directUrl, urlKey, isYandexDisk, hostOf, checkZip, downloadArchive, readJsonSafe };
