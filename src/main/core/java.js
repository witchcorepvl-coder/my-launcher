// Java 21: поиск в системе и автоматическая установка (Eclipse Temurin, без установщика)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const extract = require('extract-zip');
const { spawnSync } = require('child_process');
const { ROOT, IS_WIN, IS_MAC, MIN_JAVA } = require('./env');
const { downloadFile } = require('./net');

// ============================================================
//  ПОИСК JAVA 21+ (Windows / macOS / Linux)
// ============================================================
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

    // JRE внутри папки игры (можно положить в архив сборки)
    add(path.join(ROOT, 'runtime', 'bin', exe));
    add(path.join(ROOT, 'java', 'bin', exe));
    if (IS_MAC) add(path.join(ROOT, 'runtime', 'Contents', 'Home', 'bin', 'java'));

    if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', exe));

    if (IS_WIN) {
        const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']].filter(Boolean);
        const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru'];
        for (const base of pf) for (const v of vendors) for (const d of subdirs(path.join(base, v))) add(path.join(d, 'bin', exe));

        // Java из официального лаунчера Minecraft
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

    add('java'); // из PATH — в самом конце
    return list;
}

let cachedJava = null;

function findJava() {
    if (cachedJava) return cachedJava;
    // Предпочитаем ровно Java 21 (родная для NeoForge 1.21.1 и LWJGL 3.3.3),
    // более новую берём только если 21 не найдена.
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

// ============================================================
//  АВТОУСТАНОВКА JAVA 21 (Eclipse Temurin, без установщика и без прав админа)
// ============================================================
// Java кладётся в .minecraft_pvl/runtime/java21 и используется только лаунчером.
const RUNTIME_DIR = path.join(ROOT, 'runtime', 'java21');

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest/21/hotspot';

function adoptiumPlatform() {
    const osName = IS_WIN ? 'windows' : IS_MAC ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x32' : 'x64';
    return { osName, arch };
}

// Ищем bin/java внутри распакованной папки (на macOS это Contents/Home/bin/java)
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

async function downloadJava(r) {
    const { osName, arch } = adoptiumPlatform();
    r.log('> JAVA НЕ НАЙДЕНА — СКАЧИВАЮ JAVA 21 (ОДИН РАЗ, ~50 МБ)...');
    r.status('Скачиваю Java 21');

    // Сначала JRE (меньше), если для платформы нет — JDK
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

    const archive = path.join(ROOT, 'runtime', pkg.name);
    const tmpDir = path.join(ROOT, 'runtime', '.java_extract');
    fs.mkdirSync(path.dirname(archive), { recursive: true });

    let got = 0;
    await downloadFile(pkg.link, archive, {
        sha256: pkg.checksum,
        timeout: 120000,
        onData: (n) => { got += n; r.progress(got, pkg.size || got); }
    });

    r.log(`> РАСПАКОВКА ${release || 'JAVA'}...`);
    r.status('Устанавливаю Java');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    if (pkg.name.endsWith('.zip')) {
        await extract(archive, { dir: tmpDir });
    } else {
        // .tar.gz (macOS/Linux) — системный tar сохраняет права на запуск
        const r = spawnSync('tar', ['-xzf', archive, '-C', tmpDir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`Не удалось распаковать Java: ${r.stderr || r.error}`);
    }

    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(RUNTIME_DIR), { recursive: true });
    fs.renameSync(tmpDir, RUNTIME_DIR);
    try { fs.unlinkSync(archive); } catch {}

    const javaPath = findJavaIn(RUNTIME_DIR);
    if (!javaPath) throw new Error('Java скачана, но не найден файл java. Нажми «Играть» ещё раз.');
    if (!IS_WIN) { try { fs.chmodSync(javaPath, 0o755); } catch {} }
    const major = getJavaMajor(javaPath);
    if (major < MIN_JAVA) throw new Error('Скачанная Java не запускается. Нажми «Играть» ещё раз.');
    r.log(`> JAVA ${major} УСТАНОВЛЕНА.`);
    return { path: javaPath, major };
}

// Порядок: своя скачанная Java → системная Java 21 → скачать → (если не вышло) системная новее 21
let javaReady = null;

async function ensureJava(r) {
    if (javaReady && fs.existsSync(javaReady.path)) return javaReady;

    const own = bundledJava();
    if (own) return (javaReady = own);

    const sys = findJava();
    if (sys && sys.major === MIN_JAVA) return (javaReady = sys);

    try {
        return (javaReady = await downloadJava(r));
    } catch (e) {
        if (sys) {
            r.log(`> НЕ УДАЛОСЬ СКАЧАТЬ JAVA 21 (${e.message}). ИСПОЛЬЗУЮ JAVA ${sys.major}.`);
            return (javaReady = sys);
        }
        throw e;
    }
}

module.exports = { ensureJava, getJavaMajor };
