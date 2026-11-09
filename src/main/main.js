// Главный процесс: окно лаунчера и связь интерфейса с «движком» (папка core).
'use strict';
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Один экземпляр лаунчера
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const env = require('./core/env');
const log = require('./core/logger');
const config = require('./core/config');
const skins = require('./core/skins');
const server = require('./core/server');
const hardware = require('./core/hardware');
const launcher = require('./core/launch');
const { getBuild, getGameDir, readMarker } = require('./core/builds');

log.info(`==== PVL Craft Launcher ${app.getVersion()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome} ====`);
log.info(`ОС: ${os.type()} ${os.release()} ${os.arch()} · память ${Math.round(os.totalmem() / 1048576)} МБ · папка игры ${env.ROOT}`);
log.info(`Запуск из: ${app.getAppPath()} · упакован: ${app.isPackaged}`);

process.on('uncaughtException', (e) => log.error('uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e && e.stack || e));

let win = null;
let hwPromise = null;

// Проверка железа один раз за запуск (в фоне, пока грузится окно)
function getHardware() {
    if (!hwPromise) {
        hwPromise = hardware.detect().then((hw) => {
            log.info(`Железо: CPU ${hw.cpu} (${hw.cores} потоков) · RAM ${hw.ramMB} МБ · ${hw.os}`);
            log.info(`Видеокарты (система): ${hw.gpus.length ? hw.gpus.join(' | ') : 'не определены'}`);
            log.info(`Видеокарты (Chromium): ${JSON.stringify(hw.gpuRaw)} · производители: ${hw.vendors.join(', ') || '—'} · ${hw.tookMs} мс`);
            return hw;
        }).catch((e) => {
            log.error('Проверка железа не удалась:', e && e.stack || e);
            return { ramMB: Math.floor(os.totalmem() / 1048576), gpus: [], gpuRaw: [], vendors: [], cpu: '', cores: 0, os: '' };
        });
    }
    return hwPromise;
}

async function autoChoice() {
    const hw = await getHardware();
    const rec = hardware.recommend(hw, config.view().autoSelect);
    return { hw, rec };
}

function createWindow() {
    win = new BrowserWindow({
        width: 1120,
        height: 700,
        minWidth: 1120,
        minHeight: 700,
        resizable: false,
        maximizable: false,
        frame: false,
        show: false,
        backgroundColor: '#05070b',
        title: 'PVL Craft',
        icon: path.join(__dirname, '../../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });
    const wc = win.webContents;

    // ---- Диагностика: всё, что происходит в окне, пишем в logs/launcher.log ----
    const LEVELS = ['LOG', 'WARN', 'ERROR', 'DEBUG'];
    wc.on('console-message', (e, level, message, line, sourceId) => {
        // Electron 33: (event, level, message, line, sourceId); новые версии — поля в event
        if (e && typeof e.message === 'string') ({ level, message, lineNumber: line, sourceId } = e);
        const lv = typeof level === 'number' ? LEVELS[level] || level : String(level).toUpperCase();
        const where = sourceId ? ` (${path.basename(String(sourceId))}:${line})` : '';
        (lv === 'ERROR' ? log.error : lv === 'WARN' || lv === 'WARNING' ? log.warn : log.info)(`[окно ${lv}] ${message}${where}`);
    });
    wc.on('preload-error', (_, p, err) => log.error(`ОШИБКА PRELOAD ${p}:`, err && err.stack || err));
    wc.on('did-fail-load', (_, code, desc, url) => log.error(`Окно не загрузилось: ${code} ${desc} · ${url}`));
    wc.on('render-process-gone', (_, d) => {
        log.error(`Процесс окна упал: ${d.reason} (код ${d.exitCode})`);
        if (d.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => win && !win.isDestroyed() && win.reload(), 800);
    });
    wc.on('unresponsive', () => log.warn('Окно не отвечает'));
    wc.on('responsive', () => log.info('Окно снова отвечает'));
    wc.on('did-finish-load', () => log.info('Интерфейс загружен'));
    app.on('child-process-gone', (_, d) => log.warn(`Дочерний процесс ${d.type} завершился: ${d.reason} (код ${d.exitCode})`));

    // F12 или Ctrl+Shift+I — инструменты разработчика (чтобы посмотреть ошибки интерфейса)
    wc.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        const k = String(input.key).toLowerCase();
        if (k === 'f12' || ((input.control || input.meta) && input.shift && k === 'i')) { wc.toggleDevTools(); e.preventDefault(); }
        if (k === 'f5' || ((input.control || input.meta) && k === 'r')) { log.info('Перезагрузка интерфейса'); wc.reload(); e.preventDefault(); }
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html')).catch((e) => log.error('loadFile:', e));
    let shown = false;
    const show = () => { if (!shown && win && !win.isDestroyed()) { shown = true; win.show(); } };
    win.once('ready-to-show', show);
    setTimeout(show, 4000);   // на всякий случай — окно появится в любом случае

    // Ссылки из новостей — в браузере, а не внутри лаунчера
    wc.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); }
    });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(() => { createWindow(); getHardware(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { log.info('Лаунчер закрыт'); log.close(); });

function buildsState() {
    const out = {};
    for (const b of Object.values(env.BUILDS)) {
        const m = readMarker(b);
        out[b.id] = { installed: !!m, version: m ? m.version || null : null };
    }
    return out;
}

// Какие необязательные файлы оформления реально лежат в assets (чтобы окно не запрашивало несуществующие)
function assetList() {
    const dir = path.join(__dirname, '../../assets');
    const has = (f) => fs.existsSync(path.join(dir, f));
    let sounds = [];
    try { sounds = fs.readdirSync(path.join(dir, 'sounds')).filter(f => /\.(mp3|ogg|wav)$/i.test(f)); } catch {}
    const out = { font: has('fonts/minecraft.ttf'), music: has('music.mp3'), videoWebm: has('background.webm'), videoMp4: has('background.mp4'), sounds };
    log.info(`Оформление: ${JSON.stringify(out)}`);
    return out;
}

async function hwView() {
    const { hw, rec } = await autoChoice();
    return { gpus: hw.gpus, vendors: hw.vendors, ramMB: hw.ramMB, recommended: rec.build, reason: rec.reason, minGb: rec.minGb };
}

// ---------- IPC ----------
ipcMain.handle('app:init', async () => ({
    config: config.view(),
    builds: buildsState(),
    hardware: await hwView(),
    platform: process.platform,
    appVersion: app.getVersion(),
    totalRamMB: Math.floor(os.totalmem() / 1048576),
    gameRoot: env.ROOT,
    logFile: log.FILE,
    defaultSkin: (skins.bundledSkin() || {}).skin || null,
    assets: assetList()
}));

ipcMain.handle('config:refresh', async () => {
    await config.refresh();
    return { config: config.view(), builds: buildsState(), hardware: await hwView() };
});
ipcMain.handle('builds:state', () => buildsState());
ipcMain.handle('server:status', async () => {
    const s = await server.status(config.view().server);
    if (!s || !s.online) log.warn(`Сервер ${config.view().server} не ответил`);
    return s;
});

ipcMain.handle('skin:lookup', async (_, nick) => {
    const r = await skins.lookup(String(nick || '').trim());
    log.info(`Скин «${nick}»: ${r.found ? 'найден у Mojang' + (r.slim ? ' (slim)' : '') + (r.cape ? ' + плащ' : '') : r.offline ? 'нет связи с Mojang' : 'нет такого ника'}`);
    if (r.found && r.skin) return r;
    const def = await skins.defaultSkin().catch(() => null);
    return { ...r, skin: def ? def.skin : null, slim: false, cape: null, isDefault: true };
});

ipcMain.handle('game:play', async (e, opts) => {
    const wc = e.sender;
    opts = opts || {};
    // Какая сборка: «Авто» → по железу; иначе — то, что выбрано в настройках
    let reason = 'вручную в настройках';
    if (!opts.build || opts.build === 'auto') {
        const { rec } = await autoChoice();
        opts.build = rec.build;
        reason = `авто (${rec.reason})`;
    }
    opts.buildReason = reason;
    log.info(`==== ИГРАТЬ · ник ${opts.nick} · сборка ${String(opts.build).toUpperCase()} · ${reason} · RAM ${opts.ramMB || 'по умолчанию'} ====`);

    // Логи игры идут сотнями строк в секунду — отправляем пачками
    let buf = [], timer = null;
    const flush = () => { timer = null; if (buf.length && !wc.isDestroyed()) wc.send('game:log', buf.join('\n')); buf = []; };
    const toUi = (t) => { buf.push(String(t)); if (!timer) timer = setTimeout(flush, 120); };
    const send = (ch, ...a) => { if (!wc.isDestroyed()) wc.send(ch, ...a); };
    let lastProg = 0, lastStatus = '';
    const r = {
        log: (t) => { log.ui(String(t)); toUi(t); },                // в окно + в файл
        game: toUi,                                                  // вывод игры: в окно (в файл — pvl_log.txt)
        file: (t) => log.info(String(t)),                            // только в файл
        status: (t) => {
            const head = String(t).split(' · ')[0];
            if (head !== lastStatus) { lastStatus = head; log.info(`Статус: ${head}`); }
            send('game:status', String(t));
        },
        progress: (done, total) => {
            const now = Date.now();
            if (done >= total || now - lastProg > 100) { lastProg = now; send('game:progress', { done, total }); }
        },
        stage: (s) => { log.info(`Этап: ${s}`); send('game:stage', s); }
    };
    const t0 = Date.now();
    const result = await launcher.play(opts, r, {
        onStarted: () => {
            send('game:started');
            if (opts.hideOnStart !== false && win) setTimeout(() => win && win.minimize(), 1500);
        }
    });
    flush();
    log.info(`==== ИТОГ: ${result.ok ? 'OK' : 'ОШИБКА'}${result.code != null ? ' · код ' + result.code : ''} · ${Math.round((Date.now() - t0) / 1000)} с`
        + `${result.error ? ' · ' + result.error : ''} ====`);
    if (win && win.isMinimized()) { win.restore(); win.focus(); }
    return { ...result, build: opts.build };
});

// Ошибки и важные события интерфейса
ipcMain.on('renderer:log', (_, level, text) => (level === 'error' ? log.error : log.info)(`[интерфейс] ${String(text).slice(0, 4000)}`));

ipcMain.on('folder:open', (_, buildId) => {
    const dir = buildId === 'logs' ? log.DIR : getGameDir(getBuild(buildId));
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
});
ipcMain.on('clipboard:write', (_, text) => clipboard.writeText(String(text || '')));
ipcMain.on('link:open', (_, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:close', () => app.quit());
