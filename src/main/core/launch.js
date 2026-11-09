// Полный цикл «Играть»: сборка → Java → файлы Minecraft → запуск → (сразу на сервер)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, IS_MAC, VANILLA_ID, EXTRA_JVM_ARGS } = require('./env');
const { getBuild, getGameDir, ensureBuild, installBuild } = require('./builds');
const { ensureJava } = require('./java');
const { getOfflineUUID, isLibraryAllowed, ensureVanilla, ensureLibraries, ensureAssets, pickRam } = require('./minecraft');
const config = require('./config');

// Ошибки Windows «нет доступа» — объясняем по-человечески
function friendlyError(err) {
    const code = err && err.code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        const where = err.path ? `\nФайл: ${err.path}` : '';
        return 'Windows или антивирус не дал лаунчеру записать файл. '
            + 'Закрой Minecraft, если он запущен, и добавь папку '
            + `${ROOT} в исключения антивируса (Защитник Windows → Защита от вирусов и угроз → Исключения).${where}`;
    }
    if (code === 'ENOSPC') return 'Не хватает места на диске. Освободи место и нажми «ИГРАТЬ».';
    return (err && err.message) || String(err);
}

let busy = false;
let gameProcess = null;

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

/**
 * r — «репортёр» для интерфейса: log(text), status(text), progress(done, total), stage(name)
 * opts — { nick, build, ramMB, autoUpdate, forceUpdate, quickJoin }
 * Возвращает Promise, который завершается, когда игра закрыта (или произошла ошибка).
 */
async function play(opts, r, hooks = {}) {
    if (busy) { r.log('> Лаунчер уже запускает игру.'); return { ok: false, busy: true }; }
    if (!NICK_RE.test(opts.nick || '')) return { ok: false, error: 'Ник: от 3 до 16 символов — латиница, цифры и _' };
    busy = true;
    try {
        fs.mkdirSync(ROOT, { recursive: true });
        if (!config.isLoaded()) await config.refresh();

        const build = getBuild(opts.build);
        const gameDir = getGameDir(build);
        const fileLog = r.file || (() => {});
        r.stage('build');
        r.log(`> Сборка: ${build.name}${build.version ? ' · версия ' + build.version : ''}`
            + `${opts.buildReason ? ' · выбрана: ' + opts.buildReason : ''}`);
        r.log(`> Папка игры: ${gameDir}`);
        r.log(`> Настройки: автообновление ${opts.autoUpdate !== false ? 'да' : 'нет'} · сразу на сервер ${opts.quickJoin !== false ? 'да' : 'нет'}`
            + `${opts.forceUpdate ? ' · ПЕРЕУСТАНОВКА' : ''}`);
        const marker = opts.forceUpdate
            ? await installBuild(build, r, null)
            : await ensureBuild(build, { autoUpdate: opts.autoUpdate !== false, forceUpdate: false }, r);

        r.stage('java');
        r.status('Проверяю Java');
        const java = await ensureJava(r);
        r.log(`> Java ${java.major}: ${java.path}`);

        r.stage('files');
        const versionId = marker.versionId || build.versionId;
        const neoJsonPath = path.join(ROOT, 'versions', versionId, `${versionId}.json`);
        r.log(`> Версия NeoForge: ${versionId} · ${neoJsonPath}`);
        if (!fs.existsSync(neoJsonPath)) {
            r.log(`> ОШИБКА: нет файла ${neoJsonPath}`);
            throw new Error('Файлы сборки неполные. Открой настройки и нажми «Переустановить сборку».');
        }
        const neoData = JSON.parse(fs.readFileSync(neoJsonPath, 'utf8'));
        const parentId = neoData.inheritsFrom || VANILLA_ID;

        r.status('Проверяю файлы Minecraft');
        const vanillaData = await ensureVanilla(parentId, r);
        const allLibs = [...(vanillaData.libraries || []), ...(neoData.libraries || [])];
        await ensureLibraries(allLibs, r);
        const downloadedIndexId = await ensureAssets(vanillaData, r);

        // --- Classpath (ванильный jar НЕ добавляем: NeoForge подключает свой client-srg.jar) ---
        const cp = new Set();
        for (const lib of allLibs) {
            if (!isLibraryAllowed(lib)) continue;
            const a = lib.downloads && lib.downloads.artifact;
            if (a && a.path) {
                const p = path.join(ROOT, 'libraries', ...a.path.split('/'));
                if (fs.existsSync(p)) cp.add(p);
            }
        }
        const neoJar = path.join(ROOT, 'versions', versionId, `${versionId}.jar`);
        if (fs.existsSync(neoJar)) cp.add(neoJar);

        const sep = path.delimiter;
        const classpath = Array.from(cp).join(sep);
        const libraryDir = path.join(ROOT, 'libraries');
        const nativesDir = path.join(ROOT, 'versions', versionId, 'natives');
        fs.mkdirSync(nativesDir, { recursive: true });

        const indexesDir = path.join(ROOT, 'assets', 'indexes');
        let assetIndexId = downloadedIndexId || (vanillaData.assetIndex && vanillaData.assetIndex.id) || '17';
        if (fs.existsSync(indexesDir) && !fs.existsSync(path.join(indexesDir, `${assetIndexId}.json`))) {
            const files = fs.readdirSync(indexesDir).filter(f => f.endsWith('.json'));
            if (files.length) assetIndexId = path.basename(files[0], '.json');
        }

        const nick = opts.nick;
        const uuid = getOfflineUUID(nick);
        const vars = {
            library_directory: libraryDir, classpath_separator: sep, version_name: versionId,
            natives_directory: nativesDir, launcher_name: 'PVL-Craft', launcher_version: '2.0',
            classpath, auth_player_name: nick, game_directory: gameDir,
            assets_root: path.join(ROOT, 'assets'), assets_index_name: assetIndexId,
            auth_uuid: uuid, auth_access_token: '0', clientid: '0', auth_xuid: '0',
            user_type: 'legacy', version_type: 'release'
        };
        const fill = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
        const strArgs = (list) => (list || []).filter(a => typeof a === 'string').map(fill);

        const ramMB = pickRam(opts.ramMB || build.ramMB || 4096, r);
        const xmsMB = Math.min(2048, ramMB);
        const server = config.view().server;

        // Офлайн-сессия: accessToken = "0", userType = "legacy" (не менять — иначе ломаются сетевые моды)
        const args = [
            ...(IS_MAC ? ['-XstartOnFirstThread'] : []),
            `-Xmx${ramMB}M`, `-Xms${xmsMB}M`,
            `-Djava.library.path=${nativesDir}`,
            ...EXTRA_JVM_ARGS,
            ...strArgs(neoData.arguments && neoData.arguments.jvm),
            '-cp', classpath,
            neoData.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher',
            ...strArgs(neoData.arguments && neoData.arguments.game),
            '--username', nick,
            '--version', versionId,
            '--gameDir', gameDir,
            '--assetsDir', path.join(ROOT, 'assets'),
            '--assetIndex', assetIndexId,
            '--uuid', uuid,
            '--accessToken', '0',
            '--userType', 'legacy',
            '--versionType', 'release',
            // Сразу на сервер после загрузки (Minecraft 1.20+)
            ...(opts.quickJoin !== false && server ? ['--quickPlayMultiplayer', server] : [])
        ];

        r.stage('launch');
        r.status('Запускаю Minecraft');
        r.progress(1, 1);
        r.log(`> Игрок: ${nick} · UUID ${uuid} · память ${Math.round(ramMB / 1024)} ГБ (Xms ${xmsMB} МБ)`
            + `${opts.quickJoin !== false ? ' · сразу на сервер' : ''}`);
        r.log(`> Библиотек в classpath: ${cp.size} · ассеты: индекс ${assetIndexId} · главный класс ${neoData.mainClass || 'BootstrapLauncher'}`);
        // Полная команда — только в файл журнала (classpath очень длинный)
        fileLog(`КОМАНДА ЗАПУСКА:\n"${java.path}" ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

        const logFile = path.join(gameDir, 'pvl_log.txt');
        try { fs.unlinkSync(logFile); } catch {}
        const logStream = fs.createWriteStream(logFile, { flags: 'a' });

        const tStart = Date.now();
        const tail = [];
        return await new Promise((resolve) => {
            const child = spawn(java.path, args, { cwd: gameDir, windowsHide: true });
            gameProcess = child;
            r.log(`> Процесс Java запущен (PID ${child.pid || '?'}). Вывод игры: ${logFile}`);
            let started = false;
            const onOut = (data) => {
                const text = data.toString();
                for (const l of text.split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 80) tail.shift(); }
                logStream.write(text);
                (r.game || r.log)(text.replace(/\s+$/, ''));   // вывод игры — только в окно журнала и pvl_log.txt
                // Окно игры появилось — сообщаем интерфейсу
                if (!started && /Backend library: LWJGL|Setting user:|Loading Minecraft|ModLauncher running/i.test(text)) {
                    started = true;
                    fileLog(`Игра стартовала через ${((Date.now() - tStart) / 1000).toFixed(1)} с`);
                    hooks.onStarted && hooks.onStarted();
                }
            };
            child.stdout.on('data', onOut);
            child.stderr.on('data', onOut);
            child.on('error', (e) => {
                logStream.end();
                r.log(`> ОШИБКА ЗАПУСКА JAVA: ${e.code || ''} ${e.message} · ${java.path}`);
                resolve({ ok: false, error: `Не удалось запустить Java: ${e.message}` });
            });
            child.on('close', (code) => {
                logStream.end(`\n> Игра закрыта с кодом ${code}\n`);
                gameProcess = null;
                const mins = ((Date.now() - tStart) / 60000).toFixed(1);
                r.log(`> Игра закрыта · код ${code} · проработала ${mins} мин`);
                if (code !== 0) fileLog(`ПОСЛЕДНИЕ СТРОКИ ВЫВОДА ИГРЫ (код ${code}):\n${tail.join('\n')}`);
                resolve({ ok: code === 0, code, logFile, error: code === 0 ? null : `Игра закрылась с ошибкой (код ${code}). Лог: ${logFile}` });
            });
        });
    } catch (err) {
        r.log(`> ОШИБКА: ${err && err.code ? err.code + ' · ' : ''}${err && err.message}`);
        (r.file || (() => {}))(`СТЕК ОШИБКИ:\n${err && err.stack}`);
        return { ok: false, error: friendlyError(err) };
    } finally {
        busy = false;
    }
}

module.exports = { play, isRunning: () => !!gameProcess, isBusy: () => busy };
