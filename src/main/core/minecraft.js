// Minecraft: ванильные файлы (Mojang), библиотеки, ассеты и помощники для запуска
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { ROOT, OS_NAME, MOJANG_MANIFEST, MOJANG_RESOURCES } = require('./env');
const { downloadFile, runPool, fileSizeOk } = require('./net');

// ============================================================
//  УТИЛИТЫ
// ============================================================
function getOfflineUUID(username) {
    const md5Bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
    md5Bytes[6] = (md5Bytes[6] & 0x0f) | 0x30;
    md5Bytes[8] = (md5Bytes[8] & 0x3f) | 0x80;
    const hex = md5Bytes.toString('hex');
    return `${hex.substring(0,8)}-${hex.substring(8,12)}-${hex.substring(12,16)}-${hex.substring(16,20)}-${hex.substring(20,32)}`;
}

// Кроссплатформенная проверка правил библиотек
function isLibraryAllowed(lib) {
    if (!lib.rules) return true;
    const arch = process.arch === 'ia32' ? 'x86' : process.arch;
    let allowed = false;
    for (const rule of lib.rules) {
        let match = true;
        if (rule.os) {
            if (rule.os.name && rule.os.name !== OS_NAME) match = false;
            if (rule.os.arch && rule.os.arch !== arch) match = false;
        }
        if (rule.features) match = false; // demo / custom resolution и т.п. — не используем
        if (match) allowed = (rule.action === 'allow');
    }
    return allowed;
}

// ============================================================
//  ВАНИЛЬ: JSON + JAR + БИБЛИОТЕКИ + АССЕТЫ С СЕРВЕРОВ MOJANG
// ============================================================
async function ensureVanilla(versionId, r) {
    const dir = path.join(ROOT, 'versions', versionId);
    const jsonPath = path.join(dir, `${versionId}.json`);
    const jarPath = path.join(dir, `${versionId}.jar`);
    const cacheJsonPath = path.join(ROOT, 'cache', 'json', `${versionId}.json`);

    let data = null;
    for (const p of [jsonPath, cacheJsonPath]) {
        if (fs.existsSync(p)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (parsed.downloads && parsed.downloads.client) { data = parsed; break; }
            } catch {}
        }
    }

    if (!data) {
        r.log(`> ВАНИЛЬНАЯ ВЕРСИЯ ${versionId} НЕ НАЙДЕНА. ЗАПРОС К MOJANG...`);
        r.status('Загружаю Minecraft 1.21.1');
        const manifest = (await axios.get(MOJANG_MANIFEST, { timeout: 30000 })).data;
        const entry = (manifest.versions || []).find(v => v.id === versionId);
        if (!entry) throw new Error(`Версия ${versionId} не найдена в манифесте Mojang`);
        await downloadFile(entry.url, jsonPath, { sha1: entry.sha1 });
        data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        r.log(`> ${versionId}.json ЗАГРУЖЕН.`);
    } else if (!fs.existsSync(jsonPath)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    }

    const client = data.downloads.client;
    if (!fileSizeOk(jarPath, client.size)) {
        r.log(`> СКАЧИВАНИЕ КЛИЕНТА ${versionId}.jar...`);
        r.status('Загружаю Minecraft 1.21.1');
        let got = 0;
        await downloadFile(client.url, jarPath, {
            sha1: client.sha1,
            onData: (n) => { got += n; r.progress(got, client.size); }
        });
        r.log(`> ${versionId}.jar ЗАГРУЖЕН.`);
    }
    return data;
}

async function ensureLibraries(libs, r) {
    const queue = [];
    const seen = new Set();
    for (const lib of libs) {
        if (!isLibraryAllowed(lib)) continue;
        const art = lib.downloads && lib.downloads.artifact;
        if (!art || !art.path || !art.url) continue; // пустой url = файл генерирует установщик NeoForge (должен быть в архиве)
        const dest = path.join(ROOT, 'libraries', ...art.path.split('/'));
        if (seen.has(dest)) continue;
        seen.add(dest);
        if (!fileSizeOk(dest, art.size)) queue.push({ url: art.url, dest, sha1: art.sha1 });
    }
    if (!queue.length) return;

    r.log(`> НЕДОСТАЁТ БИБЛИОТЕК: ${queue.length}. СКАЧИВАНИЕ...`);
    r.status('Загружаю библиотеки');
    await runPool(queue, 8, (it) => downloadFile(it.url, it.dest, { sha1: it.sha1 }),
        (done, total) => r.progress(done, total));
    r.log('> БИБЛИОТЕКИ ЗАГРУЖЕНЫ.');
}

async function ensureAssets(vanillaData, r) {
    const ai = vanillaData.assetIndex;
    if (!ai || !ai.url) return null;
    const indexPath = path.join(ROOT, 'assets', 'indexes', `${ai.id}.json`);
    if (!fileSizeOk(indexPath, ai.size)) {
        r.log(`> СКАЧИВАНИЕ ИНДЕКСА АССЕТОВ ${ai.id}...`);
        await downloadFile(ai.url, indexPath, { sha1: ai.sha1 });
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const objectsDir = path.join(ROOT, 'assets', 'objects');
    const queue = [];
    const seen = new Set();
    for (const obj of Object.values(index.objects || {})) {
        if (seen.has(obj.hash)) continue;
        seen.add(obj.hash);
        const sub = obj.hash.substring(0, 2);
        const dest = path.join(objectsDir, sub, obj.hash);
        if (!fileSizeOk(dest, obj.size)) {
            queue.push({ url: `${MOJANG_RESOURCES}/${sub}/${obj.hash}`, dest, sha1: obj.hash });
        }
    }

    if (queue.length) {
        r.log(`> НЕДОСТАЁТ АССЕТОВ (ЗВУКИ/ЯЗЫКИ): ${queue.length}. СКАЧИВАНИЕ...`);
        r.status('Загружаю звуки и языки');
        let last = 0;
        await runPool(queue, 16, (it) => downloadFile(it.url, it.dest, { sha1: it.sha1 }),
            (done, total) => {
                if (done - last >= 20 || done === total) { last = done; r.progress(done, total); }
            });
        r.log('> АССЕТЫ ЗАГРУЖЕНЫ.');
    }
    return ai.id;
}

// Память: не больше, чем есть у компьютера (оставляем 2 ГБ системе), но не меньше 2 ГБ
function pickRam(requestedMB, r) {
    const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
    const maxMB = Math.max(2048, totalMB - 2048);
    if (requestedMB > maxMB) {
        r.log(`> НА ПК ${Math.round(totalMB / 1024)} ГБ ПАМЯТИ — ИГРЕ ВЫДЕЛЕНО ${Math.round(maxMB / 1024)} ГБ.`);
        return maxMB;
    }
    return requestedMB;
}

module.exports = { getOfflineUUID, isLibraryAllowed, ensureVanilla, ensureLibraries, ensureAssets, pickRam };
