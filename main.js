const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const extract = require('extract-zip');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

app.commandLine.appendSwitch('ssl-version-max', 'tls1.2');
app.commandLine.appendSwitch('ignore-certificate-errors');


const BUILDS = {
    full: {
        id: 'full',
        name: 'FULL',
        url: 'https://www.dropbox.com/scl/fi/j0zdw3p93fum06oriezk1/modpack-v1.zip?rlkey=t0v4q5x9n5ncqiw9itd9x9o79&st=3dbfviur&dl=1',
        gameDir: null,
        versionId: 'neoforge-21.1.264'
    },
    lite: {
        id: 'lite',
        name: 'LITE',
        url: 'https://www.dropbox.com/scl/fi/0pinz4xv1x0k8n4eflhqd/modpackv1macos.zip?rlkey=3pypdd72bhef8ii0doo5x3685&st=ppzfn5ka&dl=1',
        gameDir: 'builds/lite',
        versionId: 'neoforge-21.1.264'
    }
};


const SHARED_DIRS = ['libraries', 'assets', 'versions'];
const BUILD_MARKER = '.pvl_build.json';
const VANILLA_ID = '1.21.1';
const MIN_JAVA = 21;


const EXTRA_JVM_ARGS = [
    '-Dcustomskinloader.ignorePatchFailure=true',

    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8'
];

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MOJANG_RESOURCES = 'https://resources.download.minecraft.net';


const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || 'linux';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 650,
        frame: false,
        resizable: false,
        backgroundColor: '#0d0d0d',

        icon: fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : undefined,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { app.quit(); });

const minecraftDir = path.join(app.getPath('appData'), '.minecraft_pvl');

ipcMain.on('open-folder', (_, buildId) => {
    const dir = getGameDir(getBuild(buildId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
});

ipcMain.on('copy-log', (event, logs) => {
    clipboard.writeText(logs);
});


const CONFIG_SOURCES = [
    'https://raw.githubusercontent.com/witchcorepvl-coder/pvl-launcher-data/main/config.json',
    'https://cdn.jsdelivr.net/gh/witchcorepvl-coder/pvl-launcher-data@main/config.json'
];
ipcMain.handle('fetch-config', async () => {
    for (const url of CONFIG_SOURCES) {
        try {
            const res = await axios.get(`${url}?t=${Date.now()}`, { timeout: 8000, responseType: 'json' });
            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            if (data && typeof data === 'object') return { ok: true, data, source: url };
        } catch {}
    }
    return { ok: false };
});

ipcMain.handle('get-game-dir', (_, buildId) => getGameDir(getBuild(buildId)));


ipcMain.handle('get-builds-state', () => {
    const state = {};
    for (const b of Object.values(BUILDS)) {
        const m = readMarker(b);
        state[b.id] = { name: b.name, installed: !!m, installedAt: m ? m.installedAt : null };
    }
    return state;
});


ipcMain.on('remote-config', (_, data) => {
    if (!data || typeof data !== 'object' || !data.builds) return;
    for (const [id, cfg] of Object.entries(data.builds)) {
        if (BUILDS[id] && cfg && typeof cfg.url === 'string' && cfg.url.startsWith('https://')) {
            BUILDS[id].url = cfg.url;
        }
    }
});


function getBuild(id) {
    return BUILDS[id] || BUILDS.full;
}

function getGameDir(build) {
    return build.gameDir ? path.join(minecraftDir, ...build.gameDir.split('/')) : minecraftDir;
}


function directUrl(url) {
    if (!/dropbox\.com/.test(url)) return url;
    if (/[?&]dl=\d/.test(url)) return url.replace(/([?&])dl=\d/, '$1dl=1');
    return url + (url.includes('?') ? '&' : '?') + 'dl=1';
}


function urlKey(url) {
    return directUrl(url).replace(/([?&])st=[^&]*&?/, '$1').replace(/[?&]$/, '');
}

function readMarker(build) {
    const gameDir = getGameDir(build);
    const markerPath = path.join(gameDir, BUILD_MARKER);
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {}


    if (!build.gameDir) {
        const neoJson = path.join(minecraftDir, 'versions', build.versionId, `${build.versionId}.json`);
        if (fs.existsSync(path.join(minecraftDir, 'mods')) && fs.existsSync(neoJson)) {
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


async function getRemoteFingerprint(url) {
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

async function installBuild(build, sender, fingerprint) {
    const gameDir = getGameDir(build);
    const zipPath = path.join(minecraftDir, `update_${build.id}.zip`);
    const tmpDir = path.join(minecraftDir, `.extract_${build.id}`);

    fs.mkdirSync(minecraftDir, { recursive: true });
    sender.send('game-log', `> ЗАГРУЗКА СБОРКИ ${build.name} С DROPBOX...`);
    sender.send('status', `СКАЧИВАНИЕ ${build.name}`);
    await downloadBuild(directUrl(build.url), zipPath, sender);

    sender.send('game-log', '> ЗАГРУЗКА ЗАВЕРШЕНА. РАСПАКОВКА...');
    sender.send('status', 'РАСПАКОВКА АРХИВА');
    sender.send('progress', { task: 0, total: 1 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await extract(zipPath, { dir: tmpDir });

    const src = findContentRoot(tmpDir);
    const versionId = detectNeoVersion(path.join(src, 'versions'), build.versionId);


    for (const name of SHARED_DIRS) {
        const p = path.join(src, name);
        if (fs.existsSync(p)) moveMerge(p, path.join(minecraftDir, name));
    }


    fs.mkdirSync(gameDir, { recursive: true });
    const srcMods = path.join(src, 'mods');
    if (fs.existsSync(srcMods)) {
        fs.rmSync(path.join(gameDir, 'mods'), { recursive: true, force: true });
        moveMerge(srcMods, path.join(gameDir, 'mods'));
    }


    for (const name of fs.readdirSync(src)) {
        if (name === '__MACOSX') continue;
        moveMerge(path.join(src, name), path.join(gameDir, name));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const marker = {
        id: build.id,
        url: build.url,
        fingerprint: fingerprint || null,
        versionId,
        installedAt: new Date().toISOString()
    };
    writeMarker(build, marker);
    sender.send('game-log', `> СБОРКА ${build.name} УСТАНОВЛЕНА.`);
    return marker;
}


async function ensureBuild(build, { autoUpdate, forceUpdate }, sender) {
    let marker = readMarker(build);

    if (forceUpdate || !marker) {
        let fp = null;
        try { fp = await getRemoteFingerprint(build.url); } catch {}
        return installBuild(build, sender, fp);
    }

    if (marker.url && urlKey(marker.url) !== urlKey(build.url)) {
        sender.send('game-log', `> ССЫЛКА НА СБОРКУ ${build.name} ИЗМЕНИЛАСЬ. ОБНОВЛЕНИЕ...`);
        let fp = null;
        try { fp = await getRemoteFingerprint(build.url); } catch {}
        return installBuild(build, sender, fp);
    }

    if (autoUpdate) {
        sender.send('game-log', `> ПРОВЕРКА ОБНОВЛЕНИЙ СБОРКИ ${build.name}...`);
        let fp = null;
        try { fp = await getRemoteFingerprint(build.url); } catch {
            sender.send('game-log', '> НЕТ СВЯЗИ С DROPBOX — ЗАПУСК УСТАНОВЛЕННОЙ ВЕРСИИ.');
        }
        if (fp && marker.fingerprint && fp !== marker.fingerprint) {
            sender.send('game-log', '> НАЙДЕНО ОБНОВЛЕНИЕ СБОРКИ.');
            return installBuild(build, sender, fp);
        }
        if (fp && !marker.fingerprint) {

            marker.fingerprint = fp;
            writeMarker(build, marker);
        }
    }

    sender.send('game-log', `> СБОРКА ${build.name} УЖЕ УСТАНОВЛЕНА — ЗАГРУЗКА НЕ НУЖНА.`);
    return marker;
}


ipcMain.handle('server-status', async (_, address) => {
    if (typeof address !== 'string' || !/^[a-zA-Z0-9.\-:]+$/.test(address)) {
        return { error: 'Некорректный адрес сервера' };
    }
    try {
        const res = await axios.get(`https://api.mcstatus.io/v2/status/java/${address}`, { timeout: 10000 });
        const d = res.data || {};
        return {
            online: !!d.online,
            host: d.host,
            port: d.port,
            players: d.players ? { online: d.players.online, max: d.players.max } : null,
            version: d.version ? d.version.name_clean : null,
            motd: d.motd ? d.motd.clean : null,
            icon: d.icon || null
        };
    } catch (e) {
        return { error: e.message };
    }
});


function getOfflineUUID(username) {
    const md5Bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
    md5Bytes[6] = (md5Bytes[6] & 0x0f) | 0x30;
    md5Bytes[8] = (md5Bytes[8] & 0x3f) | 0x80;
    const hex = md5Bytes.toString('hex');
    return `${hex.substring(0,8)}-${hex.substring(8,12)}-${hex.substring(12,16)}-${hex.substring(16,20)}-${hex.substring(20,32)}`;
}


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
        if (rule.features) match = false; 
        if (match) allowed = (rule.action === 'allow');
    }
    return allowed;
}

function fileSizeOk(filePath, size) {
    try {
        const st = fs.statSync(filePath);
        return st.isFile() && (!size || st.size === size);
    } catch { return false; }
}

function sha1File(filePath) {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}


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


async function ensureVanilla(versionId, sender) {
    const dir = path.join(minecraftDir, 'versions', versionId);
    const jsonPath = path.join(dir, `${versionId}.json`);
    const jarPath = path.join(dir, `${versionId}.jar`);
    const cacheJsonPath = path.join(minecraftDir, 'cache', 'json', `${versionId}.json`);

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
        sender.send('game-log', `> ВАНИЛЬНАЯ ВЕРСИЯ ${versionId} НЕ НАЙДЕНА. ЗАПРОС К MOJANG...`);
        sender.send('status', 'ЗАГРУЗКА ВАНИЛИ');
        const manifest = (await axios.get(MOJANG_MANIFEST, { timeout: 30000 })).data;
        const entry = (manifest.versions || []).find(v => v.id === versionId);
        if (!entry) throw new Error(`Версия ${versionId} не найдена в манифесте Mojang`);
        await downloadFile(entry.url, jsonPath, { sha1: entry.sha1 });
        data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        sender.send('game-log', `> ${versionId}.json ЗАГРУЖЕН.`);
    } else if (!fs.existsSync(jsonPath)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    }

    const client = data.downloads.client;
    if (!fileSizeOk(jarPath, client.size)) {
        sender.send('game-log', `> СКАЧИВАНИЕ КЛИЕНТА ${versionId}.jar...`);
        sender.send('status', 'ЗАГРУЗКА КЛИЕНТА');
        let got = 0;
        await downloadFile(client.url, jarPath, {
            sha1: client.sha1,
            onData: (n) => { got += n; sender.send('progress', { task: got, total: client.size }); }
        });
        sender.send('game-log', `> ${versionId}.jar ЗАГРУЖЕН.`);
    }
    return data;
}

async function ensureLibraries(libs, sender) {
    const queue = [];
    const seen = new Set();
    for (const lib of libs) {
        if (!isLibraryAllowed(lib)) continue;
        const art = lib.downloads && lib.downloads.artifact;
        if (!art || !art.path || !art.url) continue; 
        const dest = path.join(minecraftDir, 'libraries', ...art.path.split('/'));
        if (seen.has(dest)) continue;
        seen.add(dest);
        if (!fileSizeOk(dest, art.size)) queue.push({ url: art.url, dest, sha1: art.sha1 });
    }
    if (!queue.length) return;

    sender.send('game-log', `> НЕДОСТАЁТ БИБЛИОТЕК: ${queue.length}. СКАЧИВАНИЕ...`);
    sender.send('status', 'ЗАГРУЗКА БИБЛИОТЕК');
    await runPool(queue, 8, (it) => downloadFile(it.url, it.dest, { sha1: it.sha1 }),
        (done, total) => sender.send('progress', { task: done, total }));
    sender.send('game-log', '> БИБЛИОТЕКИ ЗАГРУЖЕНЫ.');
}

async function ensureAssets(vanillaData, sender) {
    const ai = vanillaData.assetIndex;
    if (!ai || !ai.url) return null;
    const indexPath = path.join(minecraftDir, 'assets', 'indexes', `${ai.id}.json`);
    if (!fileSizeOk(indexPath, ai.size)) {
        sender.send('game-log', `> СКАЧИВАНИЕ ИНДЕКСА АССЕТОВ ${ai.id}...`);
        await downloadFile(ai.url, indexPath, { sha1: ai.sha1 });
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const objectsDir = path.join(minecraftDir, 'assets', 'objects');
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
        sender.send('game-log', `> НЕДОСТАЁТ АССЕТОВ (ЗВУКИ/ЯЗЫКИ): ${queue.length}. СКАЧИВАНИЕ...`);
        sender.send('status', 'ЗАГРУЗКА АССЕТОВ');
        let last = 0;
        await runPool(queue, 16, (it) => downloadFile(it.url, it.dest, { sha1: it.sha1 }),
            (done, total) => {
                if (done - last >= 20 || done === total) { last = done; sender.send('progress', { task: done, total }); }
            });
        sender.send('game-log', '> АССЕТЫ ЗАГРУЖЕНЫ.');
    }
    return ai.id;
}


function getJavaMajor(javaPath) {
    try {
        const r = spawnSync(javaPath, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        const out = `${r.stderr || ''}${r.stdout || ''}`;
        const m = out.match(/version "(\d+)(?:\.(\d+))?/);
        if (!m) return 0;
        let major = parseInt(m[1], 10);
        if (major === 1 && m[2]) major = parseInt(m[2], 10); // старый формат 1.8
        return major;
    } catch { return 0; }
}

function subdirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name));
    } catch { return []; }
}

function javaCandidates() {
    const exe = IS_WIN ? 'java.exe' : 'java';
    const list = [];
    const add = (p) => { if (p && !list.includes(p)) list.push(p); };

    if (process.env.PVL_JAVA) add(process.env.PVL_JAVA);

  
    add(path.join(minecraftDir, 'runtime', 'bin', exe));
    add(path.join(minecraftDir, 'java', 'bin', exe));
    if (IS_MAC) add(path.join(minecraftDir, 'runtime', 'Contents', 'Home', 'bin', 'java'));

    if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', exe));

    if (IS_WIN) {
        const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']].filter(Boolean);
        const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru'];
        for (const base of pf) for (const v of vendors) for (const d of subdirs(path.join(base, v))) add(path.join(d, 'bin', exe));


        const rt = path.join('java-runtime-delta', 'windows-x64', 'java-runtime-delta', 'bin', exe);
        if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime', rt));
        if (process.env.APPDATA) add(path.join(process.env.APPDATA, '.minecraft', 'runtime', rt));
        if (process.env['ProgramFiles(x86)']) add(path.join(process.env['ProgramFiles(x86)'], 'Minecraft Launcher', 'runtime', rt));
    } else if (IS_MAC) {
        try {
            const r = spawnSync('/usr/libexec/java_home', ['-v', `${MIN_JAVA}+`], { encoding: 'utf8', timeout: 10000 });
            const home = (r.stdout || '').trim();
            if (r.status === 0 && home) add(path.join(home, 'bin', 'java'));
        } catch {}
        for (const base of ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines')]) {
            for (const d of subdirs(base)) add(path.join(d, 'Contents', 'Home', 'bin', 'java'));
        }
        add('/opt/homebrew/opt/openjdk@21/bin/java');
        add('/usr/local/opt/openjdk@21/bin/java');
        add('/opt/homebrew/opt/openjdk/bin/java');
        const mcRt = path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'runtime');
        for (const plat of ['mac-os-arm64', 'mac-os']) {
            add(path.join(mcRt, 'java-runtime-delta', plat, 'java-runtime-delta', 'jre.bundle', 'Contents', 'Home', 'bin', 'java'));
        }
    } else {
        for (const d of subdirs('/usr/lib/jvm')) add(path.join(d, 'bin', 'java'));
    }

    add('java'); 
    return list;
}

let cachedJava = null;
function findJava() {
    if (cachedJava) return cachedJava;
    let fallback = null;
    for (const candidate of javaCandidates()) {
        if (candidate !== 'java' && !fs.existsSync(candidate)) continue;
        const major = getJavaMajor(candidate);
        if (major === MIN_JAVA) {
            cachedJava = { path: candidate, major };
            return cachedJava;
        }
        if (major > MIN_JAVA && !fallback) fallback = { path: candidate, major };
    }
    cachedJava = fallback;
    return cachedJava;
}


const RUNTIME_DIR = path.join(minecraftDir, 'runtime', 'java21');
const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest/21/hotspot';

function adoptiumPlatform() {
    const osName = IS_WIN ? 'windows' : IS_MAC ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x32' : 'x64';
    return { osName, arch };
}


function findJavaIn(dir, depth = 0) {
    const exe = IS_WIN ? 'java.exe' : 'java';
    const direct = path.join(dir, 'bin', exe);
    if (fs.existsSync(direct)) return direct;
    if (depth >= 4) return null;
    for (const sub of subdirs(dir)) {
        const found = findJavaIn(sub, depth + 1);
        if (found) return found;
    }
    return null;
}

function bundledJava() {
    const p = fs.existsSync(RUNTIME_DIR) ? findJavaIn(RUNTIME_DIR) : null;
    if (!p) return null;
    const major = getJavaMajor(p);
    return major >= MIN_JAVA ? { path: p, major } : null;
}

async function downloadJava(sender) {
    const { osName, arch } = adoptiumPlatform();
    sender.send('game-log', '> JAVA НЕ НАЙДЕНА — СКАЧИВАЮ JAVA 21 (ОДИН РАЗ, ~50 МБ)...');
    sender.send('status', 'ЗАГРУЗКА JAVA');


    let pkg = null, release = null;
    for (const imageType of ['jre', 'jdk']) {
        try {
            const res = await axios.get(ADOPTIUM_API, {
                params: { architecture: arch, image_type: imageType, os: osName, vendor: 'eclipse' },
                timeout: 20000
            });
            const item = (res.data || []).find(a => a.binary && a.binary.package && a.binary.package.link);
            if (item) { pkg = item.binary.package; release = item.release_name; break; }
        } catch {}
    }
    if (!pkg) throw new Error('Не удалось получить Java с adoptium.net. Проверь интернет и попробуй ещё раз.');

    const archive = path.join(minecraftDir, 'runtime', pkg.name);
    const tmpDir = path.join(minecraftDir, 'runtime', '.java_extract');
    fs.mkdirSync(path.dirname(archive), { recursive: true });

    let got = 0;
    await downloadFile(pkg.link, archive, {
        sha256: pkg.checksum,
        timeout: 120000,
        onData: (n) => { got += n; sender.send('progress', { task: got, total: pkg.size || got }); }
    });

    sender.send('game-log', `> РАСПАКОВКА ${release || 'JAVA'}...`);
    sender.send('status', 'УСТАНОВКА JAVA');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    if (pkg.name.endsWith('.zip')) {
        await extract(archive, { dir: tmpDir });
    } else {
        const r = spawnSync('tar', ['-xzf', archive, '-C', tmpDir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`Не удалось распаковать Java: ${r.stderr || r.error}`);
    }

    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(RUNTIME_DIR), { recursive: true });
    fs.renameSync(tmpDir, RUNTIME_DIR);
    try { fs.unlinkSync(archive); } catch {}

    const javaPath = findJavaIn(RUNTIME_DIR);
    if (!javaPath) throw new Error('Java скачана, но не найден файл java. Нажми «ИГРАТЬ» ещё раз.');
    if (!IS_WIN) { try { fs.chmodSync(javaPath, 0o755); } catch {} }
    const major = getJavaMajor(javaPath);
    if (major < MIN_JAVA) throw new Error('Скачанная Java не запускается. Нажми «ИГРАТЬ» ещё раз.');
    sender.send('game-log', `> JAVA ${major} УСТАНОВЛЕНА.`);
    return { path: javaPath, major };
}


let javaReady = null;
async function ensureJava(sender) {
    if (javaReady && fs.existsSync(javaReady.path)) return javaReady;

    const own = bundledJava();
    if (own) return (javaReady = own);

    const sys = findJava();
    if (sys && sys.major === MIN_JAVA) return (javaReady = sys);

    try {
        return (javaReady = await downloadJava(sender));
    } catch (e) {
        if (sys) {
            sender.send('game-log', `> НЕ УДАЛОСЬ СКАЧАТЬ JAVA 21 (${e.message}). ИСПОЛЬЗУЮ JAVA ${sys.major}.`);
            return (javaReady = sys);
        }
        throw e;
    }
}


function pickRam(requestedMB, sender) {
    const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
    const maxMB = Math.max(2048, totalMB - 2048);
    if (requestedMB > maxMB) {
        sender.send('game-log', `> НА ПК ${Math.round(totalMB / 1024)} ГБ ПАМЯТИ — ИГРЕ ВЫДЕЛЕНО ${Math.round(maxMB / 1024)} ГБ.`);
        return maxMB;
    }
    return requestedMB;
}


let launchBusy = false;

ipcMain.on('launch-game', async (event, args) => {
    const { username, memory, buildType, autoUpdate, forceUpdate } = args;
    const sender = event.sender;
    const finish = (info = { ok: false }) => { launchBusy = false; sender.send('launch-finished', info); };

    if (launchBusy) {
        sender.send('game-log', '> ЛАУНЧЕР УЖЕ ЗАНЯТ.');
        return;
    }
    launchBusy = true;

    try {
        if (!fs.existsSync(minecraftDir)) fs.mkdirSync(minecraftDir, { recursive: true });


        const build = getBuild(buildType);
        const gameDir = getGameDir(build);
        sender.send('game-log', `> ВЫБРАНА СБОРКА: ${build.name}`);
        const marker = await ensureBuild(build, { autoUpdate, forceUpdate }, sender);


        sender.send('status', 'ПОИСК JAVA');
        const java = await ensureJava(sender);   // нет Java — скачает сама
        sender.send('game-log', `> JAVA ${java.major}: ${java.path}`);


        const versionId = marker.versionId || build.versionId;
        const neoJsonPath = path.join(minecraftDir, 'versions', versionId, `${versionId}.json`);
        if (!fs.existsSync(neoJsonPath)) {
            throw new Error(`Не найден файл версии: ${neoJsonPath}. Нажми «ОБНОВИТЬ СБОРКУ».`);
        }
        const neoData = JSON.parse(fs.readFileSync(neoJsonPath, 'utf8'));
        const parentId = neoData.inheritsFrom || VANILLA_ID;


        sender.send('game-log', `> ПРОВЕРКА ВАНИЛЬНЫХ ФАЙЛОВ ${parentId}...`);
        const vanillaData = await ensureVanilla(parentId, sender);
        const allLibs = [...(vanillaData.libraries || []), ...(neoData.libraries || [])];
        await ensureLibraries(allLibs, sender);
        const downloadedIndexId = await ensureAssets(vanillaData, sender);

        sender.send('game-log', `> АВТОРИЗАЦИЯ ИГРОКА: ${username}`);
        sender.send('game-log', '> СБОРКА ГОТОВА К ЗАПУСКУ.');
        sender.send('status', 'ЗАПУСК MINECRAFT');
        sender.send('progress', { task: 1, total: 1 });


        const classpathSet = new Set();
        allLibs.forEach(lib => {
            if (!isLibraryAllowed(lib)) return;
            if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
                const libPath = path.join(minecraftDir, 'libraries', ...lib.downloads.artifact.path.split('/'));
                if (fs.existsSync(libPath)) classpathSet.add(libPath);
            }
        });


        const neoJar = path.join(minecraftDir, 'versions', versionId, `${versionId}.jar`);
        if (fs.existsSync(neoJar)) classpathSet.add(neoJar); // он в -DignoreList, безопасно!!!!!

        const sep = path.delimiter; 
        const classpath = Array.from(classpathSet).join(sep);
        const libraryDir = path.join(minecraftDir, 'libraries');
        const nativesDir = path.join(minecraftDir, 'versions', versionId, 'natives');
        if (!fs.existsSync(nativesDir)) fs.mkdirSync(nativesDir, { recursive: true });


        const indexesDir = path.join(minecraftDir, 'assets', 'indexes');
        let assetIndexId = downloadedIndexId || (vanillaData.assetIndex && vanillaData.assetIndex.id) || (neoData.assetIndex && neoData.assetIndex.id) || "17";

        if (fs.existsSync(indexesDir)) {
            const indexFiles = fs.readdirSync(indexesDir).filter(f => f.endsWith('.json'));
            if (!fs.existsSync(path.join(indexesDir, `${assetIndexId}.json`)) && indexFiles.length > 0) {
                assetIndexId = path.basename(indexFiles[0], '.json');
            }
        }

        const userUuid = getOfflineUUID(username);

        const replaceVars = (str) => {
            return str
                .replace(/\$\{library_directory\}/g, libraryDir)
                .replace(/\$\{classpath_separator\}/g, sep)
                .replace(/\$\{version_name\}/g, versionId)
                .replace(/\$\{natives_directory\}/g, nativesDir)
                .replace(/\$\{launcher_name\}/g, 'PVL-Launcher')
                .replace(/\$\{launcher_version\}/g, '1.0')
                .replace(/\$\{classpath\}/g, classpath)
                .replace(/\$\{auth_player_name\}/g, username)
                .replace(/\$\{game_directory\}/g, gameDir)
                .replace(/\$\{assets_root\}/g, path.join(minecraftDir, 'assets'))
                .replace(/\$\{assets_index_name\}/g, assetIndexId)
                .replace(/\$\{auth_uuid\}/g, userUuid)
                .replace(/\$\{auth_access_token\}/g, '0')
                .replace(/\$\{clientid\}/g, '0')
                .replace(/\$\{auth_xuid\}/g, '0')
                .replace(/\$\{user_type\}/g, 'legacy')
                .replace(/\$\{version_type\}/g, 'release');
        };

        const neoJvmArgs = [];
        if (neoData.arguments && neoData.arguments.jvm) {
            neoData.arguments.jvm.forEach(arg => {
                if (typeof arg === 'string') neoJvmArgs.push(replaceVars(arg));
            });
        }

        const neoGameArgs = [];
        if (neoData.arguments && neoData.arguments.game) {
            neoData.arguments.game.forEach(arg => {
                if (typeof arg === 'string') neoGameArgs.push(replaceVars(arg));
            });
        }

        const ramMB = pickRam(memory || 4096, sender);
        const xmsMB = Math.min(2048, ramMB);   
        const javaArgs = [
            // macOS: без этого флага GLFW/LWJGL падает при создании окна
            ...(IS_MAC ? ['-XstartOnFirstThread'] : []),
            `-Xmx${ramMB}M`,
            `-Xms${xmsMB}M`,
            `-Djava.library.path=${nativesDir}`,
            ...EXTRA_JVM_ARGS,
            ...neoJvmArgs,
            `-cp`, classpath,
            neoData.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher',
            ...neoGameArgs,
            `--username`, username,
            `--version`, versionId,
            `--gameDir`, gameDir,
            `--assetsDir`, path.join(minecraftDir, 'assets'),
            `--assetIndex`, assetIndexId,
            `--uuid`, userUuid,
            `--accessToken`, '0',
            `--userType`, 'legacy',
            `--versionType`, 'release'
        ];

        sender.send('game-log', `> ИСПОЛЬЗУЕТСЯ ASSET INDEX: ${assetIndexId}`);
        sender.send('game-log', '> ИНИЦИАЛИЗАЦИЯ ПРЯМОГО ЗАПУСКА JAVA...');

        const logFile = path.join(gameDir, 'pvl_log.txt');
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

        const javaProcess = spawn(java.path, javaArgs, { cwd: gameDir, windowsHide: true });

        javaProcess.stdout.on('data', (data) => {
            const line = data.toString();
            fs.appendFileSync(logFile, line);
            sender.send('game-log', line);
        });

        javaProcess.stderr.on('data', (data) => {
            const line = data.toString();
            fs.appendFileSync(logFile, line);
            sender.send('game-log', line);
        });

        javaProcess.on('error', (err) => {
            sender.send('game-log', `> ОШИБКА ЗАПУСКА JAVA: ${err.message}`);
            sender.send('status', 'ОШИБКА ЗАПУСКА');
            finish({ ok: false });
        });

        javaProcess.on('close', (code) => {
            fs.appendFileSync(logFile, `> ИГРА ЗАКРЫТА С КОДОМ ${code}\n`);
            sender.send('game-log', `> ИГРА ЗАКРЫТА С КОДОМ ${code}`);
            sender.send('status', code === 0 ? 'ГОТОВ К ЗАПУСКУ' : `ИГРА ВЫЛЕТЕЛА (КОД ${code})`);
            finish({ ok: code === 0, code });
        });

    } catch (err) {
        sender.send('game-log', `> ОШИБКА: ${err.message}`);
        sender.send('status', 'ОШИБКА ОБНОВЛЕНИЯ');
        finish({ ok: false });
    }
});

async function downloadBuild(url, dest, sender) {
    const res = await axios.get(url, {
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const totalLength = parseInt(res.headers['content-length'], 10) || 0;
    let downloaded = 0;
    const writer = fs.createWriteStream(dest);

    res.data.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalLength) {
            sender.send('progress', { task: downloaded, total: totalLength });
        } else {
            sender.send('progress', { task: downloaded, total: downloaded + (1024 * 1024 * 50) });
        }
    });

    res.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        res.data.on('error', reject);
    });
}
