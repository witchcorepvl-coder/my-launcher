// Сборки FULL / LITE: где лежат, какая версия установлена, установка и обновление
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const extract = require('extract-zip');
const { ROOT, BUILDS, SHARED_DIRS, BUILD_MARKER } = require('./env');
const { directUrl, urlKey, isYandexDisk, downloadArchive, hostOf } = require('./net');

const okUrl = (u) => typeof u === 'string' && u.startsWith('https://');

function normalizeSource(src) {
    if (okUrl(src)) return { urls: [src] };
    if (src && Array.isArray(src.parts) && src.parts.length && src.parts.every(okUrl)) return { urls: src.parts.slice() };
    return null;
}

// ============================================================
//  СБОРКИ: УСТАНОВКА / ПРОВЕРКА / ПЕРЕКЛЮЧЕНИЕ
// ============================================================
function getBuild(id) {
    return BUILDS[id] || BUILDS.full;
}

function getGameDir(build) {
    return build.gameDir ? path.join(ROOT, ...build.gameDir.split('/')) : ROOT;
}

function readMarker(build) {
    const gameDir = getGameDir(build);
    const markerPath = path.join(gameDir, BUILD_MARKER);
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {}

    // Старая установка FULL (до появления маркера): моды и NeoForge уже лежат в корне
    if (!build.gameDir) {
        const neoJson = path.join(ROOT, 'versions', build.versionId, `${build.versionId}.json`);
        if (fs.existsSync(path.join(ROOT, 'mods')) && fs.existsSync(neoJson)) {
            const legacy = { id: build.id, url: build.url, fingerprint: null, versionId: build.versionId, installedAt: null, legacy: true };
            writeMarker(build, legacy);
            return legacy;
        }
    }
    return null;
}

function writeMarker(build, data) {
    const gameDir = getGameDir(build);
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, BUILD_MARKER), JSON.stringify(data, null, 2));
}

// «Отпечаток» архива на Dropbox (etag / размер) — чтобы понять, обновился ли он,
// не скачивая весь файл. Запрашиваем только 1 байт.
async function getRemoteFingerprint(url) {
    if (isYandexDisk(url)) {
        const r = await axios.get('https://cloud-api.yandex.net/v1/disk/public/resources',
            { params: { public_key: url }, timeout: 15000 });
        return 'ya:' + (r.data.sha256 || r.data.md5 || r.data.size);
    }
    const res = await axios.get(directUrl(url), {
        responseType: 'stream',
        timeout: 15000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Range': 'bytes=0-0' }
    });
    res.data.destroy();
    const h = res.headers;
    const total = (h['content-range'] || '').split('/')[1];
    return h['etag'] || total || h['content-length'] || null;
}

// Перемещение с заменой: если папки нет — просто переименовываем (быстро), иначе сливаем
function moveMerge(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try { fs.renameSync(src, dest); return; } catch {}
        fs.cpSync(src, dest, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
        return;
    }
    const st = fs.statSync(src);
    if (!st.isDirectory()) {
        fs.rmSync(dest, { recursive: true, force: true });
        try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); }
        return;
    }
    for (const name of fs.readdirSync(src)) moveMerge(path.join(src, name), path.join(dest, name));
    fs.rmSync(src, { recursive: true, force: true });
}

// Архив может содержать файлы в корне или в одной вложенной папке
function findContentRoot(dir) {
    const entries = fs.readdirSync(dir).filter(n => n !== '__MACOSX' && !n.startsWith('.'));
    const markers = ['mods', 'versions', 'libraries', 'config'];
    if (entries.some(n => markers.includes(n))) return dir;
    if (entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory()) {
        return findContentRoot(path.join(dir, entries[0]));
    }
    return dir;
}

function detectNeoVersion(versionsDir, fallback) {
    try {
        const list = fs.readdirSync(versionsDir).filter(n => /^neoforge-/i.test(n) &&
            fs.existsSync(path.join(versionsDir, n, `${n}.json`)));
        if (list.includes(fallback)) return fallback;
        if (list.length) return list.sort().pop();
    } catch {}
    return fallback;
}

async function installBuild(build, r, fingerprint) {
    const gameDir = getGameDir(build);
    const zipPath = path.join(ROOT, `update_${build.id}.zip`);
    const tmpDir = path.join(ROOT, `.extract_${build.id}`);

    fs.mkdirSync(ROOT, { recursive: true });
    const sources = build.sources || [{ urls: [build.url] }];
    r.log(`> ЗАГРУЗКА СБОРКИ ${build.name}${build.version ? ' (версия ' + build.version + ')' : ''}...`);
    r.log(`>   папка сборки: ${gameDir}`);
    r.log(`>   источников: ${sources.length} → ${sources.map(s => (s.urls || [s]).map(hostOf).join('+')).join(', ')}`);
    r.status('Скачиваю сборку');
    const tDl = Date.now();
    await downloadArchive(sources, zipPath, r, build.name);

    r.log(`> ЗАГРУЗКА ЗАВЕРШЕНА ЗА ${Math.round((Date.now() - tDl) / 1000)} С. РАСПАКОВКА...`);
    const tEx = Date.now();
    r.status('Распаковываю сборку');
    r.progress(0, 1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
        await extract(zipPath, { dir: tmpDir });
    } catch (e) {
        r.log(`>   ОШИБКА РАСПАКОВКИ: ${e && (e.code || '')} ${e && e.message}`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try { fs.unlinkSync(zipPath); } catch {}
        if (/ENOSPC/i.test(String(e && (e.code || e.message)))) {
            throw new Error('Не хватает места на диске для распаковки сборки. Освободи место и нажми «Играть».');
        }
        throw new Error('Архив сборки оказался повреждён. Нажми «Играть» ещё раз — он скачается заново.');
    }

    const src = findContentRoot(tmpDir);
    const versionId = detectNeoVersion(path.join(src, 'versions'), build.versionId);
    r.log(`>   распаковано за ${Math.round((Date.now() - tEx) / 1000)} с · корень архива: ${path.relative(tmpDir, src) || '.'}`
        + ` · содержимое: ${fs.readdirSync(src).join(', ')} · версия NeoForge: ${versionId}`);

    // Общие папки — в корень
    for (const name of SHARED_DIRS) {
        const p = path.join(src, name);
        if (fs.existsSync(p)) moveMerge(p, path.join(ROOT, name));
    }

    // mods заменяем целиком — иначе остаются удалённые из сборки моды и дубли версий
    fs.mkdirSync(gameDir, { recursive: true });
    const srcMods = path.join(src, 'mods');
    if (fs.existsSync(srcMods)) {
        fs.rmSync(path.join(gameDir, 'mods'), { recursive: true, force: true });
        moveMerge(srcMods, path.join(gameDir, 'mods'));
    }

    // Остальное (config, kubejs, resourcepacks, options.txt...) — сливаем в папку сборки
    for (const name of fs.readdirSync(src)) {
        if (name === '__MACOSX') continue;
        moveMerge(path.join(src, name), path.join(gameDir, name));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const marker = {
        id: build.id,
        url: build.url,
        version: build.version || null,
        fingerprint: fingerprint || null,
        versionId,
        installedAt: new Date().toISOString()
    };
    writeMarker(build, marker);
    r.log(`> СБОРКА ${build.name} УСТАНОВЛЕНА.`);
    return marker;
}

// Решаем, качать ли сборку: нет установки / принудительно / сменилась ссылка / обновился архив
async function ensureBuild(build, { autoUpdate, forceUpdate }, r) {
    let marker = readMarker(build);

    if (forceUpdate || !marker) {
        let fp = null;
        if (!build.version) { try { fp = await getRemoteFingerprint(build.url); } catch {} }
        return installBuild(build, r, fp);
    }

    // Новый способ: номер версии из config.json (не зависит от того, какое хранилище доступно)
    if (build.version && marker.version) {
        if (marker.version !== build.version) {
            if (!autoUpdate) {
                r.log(`> ДОСТУПНА НОВАЯ ВЕРСИЯ СБОРКИ ${build.name} (${build.version}). `
                    + 'ВКЛЮЧИ АВТООБНОВЛЕНИЕ ИЛИ НАЖМИ «Переустановить сборку» в настройках.');
                return marker;
            }
            r.log(`> НОВАЯ ВЕРСИЯ СБОРКИ ${build.name}: ${marker.version} → ${build.version}`);
            return installBuild(build, r, null);
        }
        r.log(`> СБОРКА ${build.name} (ВЕРСИЯ ${build.version}) УЖЕ УСТАНОВЛЕНА.`);
        return marker;
    }
    // Установка старым лаунчером: один раз проверяем по-старому и запоминаем номер версии
    if (build.version && !marker.version) {
        const m = await legacyEnsure(build, marker, { autoUpdate }, r);
        if (!m.version) { m.version = build.version; writeMarker(build, m); }
        return m;
    }
    return legacyEnsure(build, marker, { autoUpdate }, r);
}

async function legacyEnsure(build, marker, { autoUpdate }, r) {
    if (marker.url && urlKey(marker.url) !== urlKey(build.url)) {
        r.log(`> ССЫЛКА НА СБОРКУ ${build.name} ИЗМЕНИЛАСЬ. ОБНОВЛЕНИЕ...`);
        let fp = null;
        try { fp = await getRemoteFingerprint(build.url); } catch {}
        return installBuild(build, r, fp);
    }

    if (autoUpdate) {
        r.log(`> ПРОВЕРКА ОБНОВЛЕНИЙ СБОРКИ ${build.name}...`);
        let fp = null;
        try { fp = await getRemoteFingerprint(build.url); } catch {
            r.log('> НЕТ СВЯЗИ С DROPBOX — ЗАПУСК УСТАНОВЛЕННОЙ ВЕРСИИ.');
        }
        if (fp && marker.fingerprint && fp !== marker.fingerprint) {
            r.log('> НАЙДЕНО ОБНОВЛЕНИЕ СБОРКИ.');
            return installBuild(build, r, fp);
        }
        if (fp && !marker.fingerprint) {
            // старая установка без отпечатка — считаем актуальной и запоминаем
            marker.fingerprint = fp;
            writeMarker(build, marker);
        }
    }

    r.log(`> СБОРКА ${build.name} УЖЕ УСТАНОВЛЕНА — ЗАГРУЗКА НЕ НУЖНА.`);
    return marker;
}

module.exports = { normalizeSource, okUrl, getBuild, getGameDir, readMarker, writeMarker, installBuild, ensureBuild };
