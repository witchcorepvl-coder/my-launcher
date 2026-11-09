// Интерфейс лаунчера PVL Craft
// Весь код внутри функции: имя «pvl» на верхнем уровне конфликтует с window.pvl из preload
// (contextBridge делает это свойство неудаляемым → «Identifier 'pvl' has already been declared» → пустое окно).
'use strict';
(() => {

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const pvl = window.pvl;

// ---------- Ошибки интерфейса: в файл журнала и на экран, а не пустое окно ----------
function report(level, text) { try { pvl && pvl.log(level, text); } catch {} }
function showFatal(text) {
    report('error', 'FATAL: ' + text);
    document.body.classList.remove('booting'); document.body.classList.add('ready');
    const box = document.getElementById('fatal');
    if (box) { document.getElementById('fatalText').textContent = text; box.classList.remove('hidden'); }
}
window.addEventListener('error', (e) => {
    const t = `${e.message || 'ошибка'} @ ${(e.filename || '').split('/').pop()}:${e.lineno || 0}${e.error && e.error.stack ? '\n' + e.error.stack : ''}`;
    report('error', t);
    if (!document.body.classList.contains('ready')) showFatal(t);
});
window.addEventListener('unhandledrejection', (e) => report('error', 'Promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
if (!pvl) {
    showFatal('Не загрузился мост лаунчера (preload.js). Окно открыто без доступа к движку.\n'
        + 'Проверь, что файл src/main/preload.js на месте, и посмотри logs/launcher.log.');
    return;
}

// Пасхалка: эти ники → сердечки и салют
const EASTER_NICKS = ['g17z4'];
const isEaster = (n) => EASTER_NICKS.includes(String(n || '').trim().toLowerCase());

// Сплэши по умолчанию (основной список — в config.json → "splashes")
const DEFAULT_SPLASHES = [
    'ИЗ СОВЫ В КОРАБЛЬ', 'Трущель - ЖИВ', 'Павловские комары суровее вардена!',
    'Жарче, чем на пляже Павловского пруда!', 'Заблудился в Ленточном бору...', 'Пинг до Барнаула: 2мс!',
    'Алтайский край одобряет!', 'NeoForge 1.21.1 Ready!', 'Не копай под себя!', 'Крипер сзади!',
    'Алмазы на 11 высоте!', 'Где мой гравий?', 'Свинозомби помнят всё...'
];
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const STAGES = { build: 'Сборка', java: 'Java', files: 'Файлы игры', launch: 'Запуск' };

// ---------- Хранилище настроек ----------
const store = {
    get(k, d) { try { const v = localStorage.getItem('pvl.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('pvl.' + k, JSON.stringify(v)); } catch {} }
};
const settings = Object.assign(
    { quickJoin: true, hideOnStart: true, autoUpdate: true, sfx: true, sfxVol: 60, musicVol: 35, ram: {}, buildMode: 'auto' },
    store.get('settings', {})
);
if (!['auto', 'full', 'lite'].includes(settings.buildMode)) settings.buildMode = 'auto';
const saveSettings = () => store.set('settings', settings);

const state = {
    info: null, config: null, builds: {}, hw: null,
    busy: false, inGame: false, logLines: [], lookupSeq: 0, skin: null
};
// Какая сборка реально запустится: «Авто» → по железу (NVIDIA и больше 8 ГБ → FULL, иначе LITE)
const effectiveBuild = () => (settings.buildMode === 'auto' ? (state.hw && state.hw.recommended) || 'lite' : settings.buildMode);

// =========================================================
//  Маленькие помощники
// =========================================================
function toast(text, kind = 'info', action = null, ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const icon = document.createElement('span'); icon.className = 't-icon';
    icon.textContent = kind === 'error' ? '!' : kind === 'ok' ? '✓' : 'i';
    const msg = document.createElement('span'); msg.textContent = text;
    el.append(icon, msg);
    if (action) {
        const b = document.createElement('button'); b.textContent = action.label;
        b.onclick = () => { action.run(); close(); };
        el.append(b);
    }
    $('#toasts').append(el);
    let t = setTimeout(close, ms);
    el.onmouseenter = () => clearTimeout(t);
    el.onmouseleave = () => { t = setTimeout(close, 1800); };
    function close() { el.classList.add('out'); setTimeout(() => el.remove(), 350); }
}

function setRangeFill(r) { const p = ((r.value - r.min) / (r.max - r.min)) * 100; r.style.setProperty('--fill', p + '%'); }
const gb = (mb) => Math.round(mb / 1024);

// Безопасный HTML для новостей: только простое форматирование
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'SPAN', 'P', 'UL', 'OL', 'LI', 'A', 'H3', 'H4', 'SMALL', 'CODE', 'HR']);
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;
function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '').replace(/\r?\n/g, '<br>');
    const walk = (src, dst) => {
        for (const n of src.childNodes) {
            if (n.nodeType === 3) { dst.append(document.createTextNode(n.textContent)); continue; }
            if (n.nodeType !== 1) continue;
            if (!ALLOWED.has(n.tagName)) { walk(n, dst); continue; }
            const el = document.createElement(n.tagName);
            if (n.tagName === 'SPAN' && n.style && n.style.color && COLOR_RE.test(n.style.color.replace(/\s/g, ''))) el.style.color = n.style.color;
            if (n.tagName === 'A') {
                const href = n.getAttribute('href') || '';
                if (/^https:\/\//.test(href)) { el.dataset.href = href; el.title = href; }
            }
            walk(n, el); dst.append(el);
        }
    };
    const out = document.createDocumentFragment();
    walk(tpl.content, out);
    return out;
}

// =========================================================
//  Новости, сплэш, сервер
// =========================================================
function renderNews() {
    const body = $('#newsBody'), badge = $('#newsBadge');
    const c = state.config;
    body.textContent = '';
    if (c && c.news) body.append(sanitize(c.news));
    else body.append(sanitize('<b>Новостей пока нет.</b>\nКак только они появятся — ты увидишь их здесь.'));
    body.querySelectorAll('a[data-href]').forEach(a => a.onclick = () => pvl.openLink(a.dataset.href));
    requestAnimationFrame(() => body.classList.toggle('can-scroll', body.scrollHeight > body.clientHeight + 2));
    if (c && c.fromCache && c.hasConfig) { badge.textContent = 'Сохранённые'; badge.className = 'chip warn'; badge.dataset.tip = 'Нет связи с GitHub — показаны последние загруженные новости'; }
    else badge.className = 'chip hidden';
}

function pickSplash() {
    const list = (state.config && state.config.splashes && state.config.splashes.length) ? state.config.splashes : DEFAULT_SPLASHES;
    let s = list[Math.floor(Math.random() * list.length)];
    if (list.length > 1) while (s === $('#splash').textContent) s = list[Math.floor(Math.random() * list.length)];
    const el = $('#splash');
    el.textContent = s;
    el.style.fontSize = s.length > 30 ? '11px' : s.length > 20 ? '12.5px' : '14px';
}

function showSplash() {
    const el = $('#splash');
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

// 1 игрок, 2 игрока, 5 игроков
function players(n) {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? 'игрок' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'игрока' : 'игроков';
}

let lastOnline = null;
async function updateServer() {
    let s = null;
    try { s = await pvl.serverStatus(); } catch {}
    const icon = $('#serverIcon'), count = $('#onlineCount'), word = $('#onlineWord'), pill = $('#serverPill');
    icon.classList.remove('online', 'offline');
    if (s && s.online) {
        icon.classList.add('online'); pill.classList.remove('is-offline');
        icon.style.backgroundImage = s.icon ? `url("${s.icon}")` : '';
        const n = (s.players && s.players.online) || 0;
        count.textContent = n;
        word.textContent = `${players(n)} онлайн`;
        if (lastOnline !== null && lastOnline !== n) { count.classList.remove('bump'); void count.offsetWidth; count.classList.add('bump'); setTimeout(() => count.classList.remove('bump'), 500); }
        lastOnline = n;
        const list = (s.players && s.players.list) || [];
        pill.dataset.tip = list.length ? 'Сейчас играют:\n' + list.slice(0, 12).join('\n') + (list.length > 12 ? `\nи ещё ${list.length - 12}` : '')
            : n ? '' : 'Сейчас никого — будь первым!';
    } else {
        icon.classList.add('offline'); pill.classList.add('is-offline');
        word.textContent = 'Сервер недоступен';
        lastOnline = null;
        pill.dataset.tip = 'Сервер не отвечает. Возможно, он перезапускается.';
    }
}

// =========================================================
//  Сборки
// =========================================================
function placeIndicator() {
    const active = $(`#buildPicker .seg[data-build="${settings.buildMode}"]`), ind = $('#buildPicker .seg-indicator');
    if (!active || !active.offsetWidth) return;
    ind.style.width = active.offsetWidth + 'px';
    ind.style.transform = `translateX(${active.offsetLeft - 4}px)`;
}

function hwText() {
    const hw = state.hw;
    if (!hw) return 'железо не определено';
    const gpu = hw.gpus && hw.gpus.length ? hw.gpus.join(' + ') : 'видеокарта не определена';
    return `${gpu} · ${Math.round(hw.ramMB / 1024)} ГБ памяти`;
}

function renderBuilds() {
    const mode = settings.buildMode, id = effectiveBuild(), rec = state.hw ? state.hw.recommended : 'lite';
    $$('#buildPicker .seg').forEach(b => b.classList.toggle('active', b.dataset.build === mode));
    placeIndicator();
    const hint = $('#buildHint');
    if (mode === 'auto') {
        hint.textContent = `Лаунчер сам выбрал ${rec.toUpperCase()}: ${hwText()}. `
            + `FULL ставится, если есть видеокарта NVIDIA и больше ${(state.hw && state.hw.minGb) || 8} ГБ памяти.`;
    } else {
        hint.textContent = `Выбрано вручную. «Авто» выбрал бы ${rec.toUpperCase()} (${hwText()}).`;
    }
    const inst = state.builds[id] || {};
    const want = state.config && state.config.builds[id] ? state.config.builds[id].version : null;
    const el = $('#buildState');
    if (!inst.installed) { el.textContent = `${id.toUpperCase()} скачается при нажатии «Играть»`; el.className = 'hint left muted'; }
    else if (want && inst.version && want !== inst.version) { el.textContent = `${id.toUpperCase()}: есть обновление ${inst.version} → ${want}`; el.className = 'hint left warn'; }
    else { el.textContent = `${id.toUpperCase()} установлена${inst.version ? ' · версия ' + inst.version : ''}`; el.className = 'hint left ok'; }
    $('#ramBuildName').textContent = id.toUpperCase();
    syncRam();
}

function selectBuild(mode) {
    if (state.busy || mode === settings.buildMode) return;
    settings.buildMode = mode; saveSettings();
    report('info', `Выбор сборки в настройках: ${mode} → запустится ${effectiveBuild().toUpperCase()}`);
    Sfx.play('toggle', mode !== 'auto');
    renderBuilds();
}

// =========================================================
//  Скин по нику
// =========================================================
let nickTimer = null;
function nickChanged() {
    const field = $('#nickField'), input = $('#nick'), st = $('#nickState'), hint = $('#nickHint');
    const v = input.value.trim();
    field.classList.remove('error'); hint.classList.remove('error');
    clearTimeout(nickTimer);
    if (v && !/^[A-Za-z0-9_]*$/.test(v)) {
        st.textContent = ''; hint.textContent = 'Только латиница, цифры и _'; hint.classList.add('error');
        return;
    }
    store.set('nick', v);
    if (!isEaster(v)) { Celebrate.stop(); hint.classList.remove('love'); }
    if (v.length < 3) { st.textContent = ''; st.className = ''; hint.textContent = v ? 'Минимум 3 символа' : 'Скин подтянется по нику с Mojang'; return; }
    st.textContent = '…'; st.className = '';
    nickTimer = setTimeout(() => loadSkin(v, true), 650);
}

async function loadSkin(nick, animate) {
    const seq = ++state.lookupSeq;
    const loader = $('#skinLoader'), st = $('#nickState'), hint = $('#nickHint');
    const t = setTimeout(() => loader.classList.remove('hidden'), 250);
    let r = null;
    try { r = await pvl.lookupSkin(nick); } catch {}
    clearTimeout(t); loader.classList.add('hidden');
    if (seq !== state.lookupSeq) return;          // пока ждали, ник уже поменяли
    if (r && r.found && !r.isDefault) {
        st.textContent = '✓ Mojang'; st.className = 'ok';
        hint.textContent = `Скин игрока ${r.name}`;
    } else if (r && r.offline) {
        st.textContent = ''; hint.textContent = 'Нет связи с Mojang — стандартный скин';
    } else {
        st.textContent = ''; hint.textContent = 'Такого ника нет у Mojang — стандартный скин';
    }
    await SkinView.set(r && r.skin ? { skin: r.skin, slim: !!r.slim, cape: r.cape || null } : null, animate);
    if (seq === state.lookupSeq && isEaster(nick) && isEaster($('#nick').value)) startEaster();
}

// ♥ Пасхалка: сердечки по всему окну + салют за скином
function startEaster() {
    const hint = $('#nickHint');
    hint.textContent = '♥ Самому особенному игроку ♥'; hint.classList.add('love');
    $('#nickState').textContent = '♥'; $('#nickState').className = 'love';
    if (Celebrate.isActive()) return;
    const go = () => {
        if (!isEaster($('#nick').value)) return;
        const r = $('#skinCanvas').getBoundingClientRect();
        Celebrate.start(r.left + r.width / 2, r.top + r.height * 0.45);
        SkinView.cheer();
        report('info', 'Пасхалка g17z4 ♥');
    };
    // при запуске ждём, пока закончится вступление
    if (document.body.classList.contains('ready')) setTimeout(go, 120);
    else document.addEventListener('pvl:intro', () => setTimeout(go, 1600), { once: true });
}

// =========================================================
//  Запуск игры
// =========================================================
function setPlay(mode, title, sub) {
    const b = $('#play');
    b.classList.toggle('busy', mode === 'busy');
    b.classList.toggle('ingame', mode === 'ingame');
    $('#playTitle').textContent = title;
    $('#playSub').textContent = sub;
    if (mode !== 'busy') { $('.play-fill').style.transform = 'scaleX(0)'; $('#playPercent').textContent = ''; }
}
function idlePlay() { setPlay('idle', 'Играть', settings.quickJoin ? 'Сразу на сервер' : 'Главное меню игры'); }

function appendLog(text) {
    const lines = String(text).split('\n');
    const log = $('#log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    const frag = document.createDocumentFragment();
    for (const l of lines) {
        state.logLines.push(l);
        const span = document.createElement('span');
        if (/ERROR|FATAL|Exception|ОШИБКА|Ошибка/.test(l)) span.className = 'err';
        else if (l.startsWith('>   ')) span.className = 'dim';
        span.textContent = l + '\n';
        frag.append(span);
    }
    log.append(frag);
    while (log.childNodes.length > 3000) log.removeChild(log.firstChild);
    if (state.logLines.length > 6000) state.logLines.splice(0, state.logLines.length - 6000);
    if (atBottom) log.scrollTop = log.scrollHeight;
}

async function play(forceUpdate = false) {
    if (state.inGame) return;
    if (state.busy) { openConsole(); return; }
    const nick = $('#nick').value.trim();
    if (!NICK_RE.test(nick)) {
        const f = $('#nickField'); f.classList.remove('error'); void f.offsetWidth; f.classList.add('error');
        $('#nickHint').textContent = 'Ник: от 3 до 16 символов — латиница, цифры и _';
        $('#nickHint').classList.add('error');
        $('#nick').focus();
        Sfx.play('error');
        return;
    }
    Sfx.play('tap');
    state.busy = true;
    document.body.classList.add('is-busy');
    state.logLines = []; $('#log').textContent = '';
    setPlay('busy', 'Подготовка…', 'Сборка');

    const build = effectiveBuild();
    const result = await pvl.play({
        nick, build: settings.buildMode, forceUpdate,
        ramMB: settings.ram[build] || null,
        autoUpdate: settings.autoUpdate, quickJoin: settings.quickJoin, hideOnStart: settings.hideOnStart
    }).catch(e => ({ ok: false, error: e.message }));

    state.busy = false; state.inGame = false;
    document.body.classList.remove('is-busy');
    idlePlay();
    fadeMusic(true);
    state.builds = await pvl.buildsState().catch(() => state.builds);
    renderBuilds();
    if (result && result.error) {
        appendLog('> ' + result.error);
        Sfx.play('error');
        toast(result.error, 'error', { label: 'Журнал', run: openConsole }, 9000);
    }
}

// «Скачиваю сборку · 412 из 1520 МБ» → заголовок + подпись
let stageName = '';
function subscribe() {
pvl.onStatus((t) => {
    if (!state.busy || state.inGame) return;
    const [title, ...rest] = String(t).split(' · ');
    $('#playTitle').textContent = title;
    $('#playSub').textContent = rest.length ? rest.join(' · ') : stageName;
});
pvl.onStage((s) => { stageName = STAGES[s] || ''; if (state.busy && !state.inGame) $('#playSub').textContent = stageName; });
pvl.onProgress(({ done, total }) => {
    if (!state.busy || state.inGame) return;
    const k = total ? Math.max(0, Math.min(1, done / total)) : 0;
    $('.play-fill').style.transform = `scaleX(${k})`;
    $('#playPercent').textContent = Math.round(k * 100) + '%';
});
pvl.onLog(appendLog);
pvl.onStarted(() => {
    state.inGame = true;
    setPlay('ingame', 'В игре', 'Удачной игры!');
    Sfx.play('success');
    SkinView.cheer();
    fadeMusic(false);
});
}

// =========================================================
//  Журнал и настройки
// =========================================================
function openConsole() { closeSettings(); $('#consoleSheet').classList.add('open'); Sfx.play('pop'); const l = $('#log'); l.scrollTop = l.scrollHeight; }
function closeConsole() { $('#consoleSheet').classList.remove('open'); }
function openSettings() { closeConsole(); $('#settingsSheet').classList.add('open'); $('#scrim').classList.add('show'); Sfx.play('pop'); }
function closeSettings() { $('#settingsSheet').classList.remove('open'); $('#scrim').classList.remove('show'); }

function syncRam() {
    const r = $('#ram');
    if (!state.info) return;
    const maxGb = Math.max(2, Math.min(16, Math.floor((state.info.totalRamMB - 2048) / 1024)));
    r.max = maxGb; r.min = 2;
    const id = effectiveBuild();
    const def = state.config && state.config.builds[id] ? state.config.builds[id].ramMB : 4096;
    const cur = Math.min(maxGb, gb(settings.ram[id] || def));
    r.value = cur;
    $('#ramValue').textContent = `${cur} ГБ`;
    $('#ramHint').textContent = `На этом компьютере ${gb(state.info.totalRamMB)} ГБ памяти. Рекомендуем для ${id.toUpperCase()}: ${Math.min(maxGb, gb(def))} ГБ`;
    setRangeFill(r);
}

function bindSettings() {
    const bindToggle = (id, key, after) => {
        const el = $(id); el.checked = !!settings[key];
        el.onchange = () => { settings[key] = el.checked; saveSettings(); Sfx.play('toggle', el.checked); after && after(); };
    };
    bindToggle('#optQuickJoin', 'quickJoin', () => !state.busy && !state.inGame && idlePlay());
    bindToggle('#optHide', 'hideOnStart');
    bindToggle('#optAutoUpdate', 'autoUpdate');
    bindToggle('#optSfx', 'sfx', () => Sfx.setEnabled(settings.sfx));

    const ram = $('#ram');
    ram.oninput = () => {
        settings.ram[effectiveBuild()] = ram.value * 1024; saveSettings();
        $('#ramValue').textContent = `${ram.value} ГБ`; setRangeFill(ram);
    };
    ram.onchange = () => Sfx.play('tap');

    const sv = $('#sfxVol'); sv.value = settings.sfxVol; setRangeFill(sv);
    sv.oninput = () => { settings.sfxVol = +sv.value; Sfx.setVolume(sv.value / 100); setRangeFill(sv); saveSettings(); };
    sv.onchange = () => Sfx.play('tap');

    const mv = $('#musicVol'); mv.value = settings.musicVol; setRangeFill(mv);
    mv.oninput = () => { settings.musicVol = +mv.value; setRangeFill(mv); saveSettings(); const m = $('#music'); if (!m.paused) m.volume = settings.musicVol / 100; };

    $('#btnOpenFolder').onclick = () => { Sfx.play('tap'); pvl.openFolder(effectiveBuild()); };
    $('#btnShowLog').onclick = () => openConsole();
    $('#btnOpenLogs').onclick = () => { Sfx.play('tap'); pvl.openFolder('logs'); };
    let confirmTimer = null;
    $('#btnReinstall').onclick = (e) => {
        const b = e.currentTarget;
        if (state.busy || state.inGame) return;
        if (!b.dataset.confirm) {
            b.dataset.confirm = '1'; b.textContent = `Точно? Сборка ${effectiveBuild().toUpperCase()} скачается заново`;
            Sfx.play('tap');
            confirmTimer = setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Переустановить сборку'; }, 4000);
            return;
        }
        clearTimeout(confirmTimer); delete b.dataset.confirm; b.textContent = 'Переустановить сборку';
        closeSettings(); play(true);
    };
    $('#about').textContent = `PVL Craft Launcher ${state.info.appVersion}\nПапка игры: ${state.info.gameRoot}\nЛог лаунчера: ${state.info.logFile || '—'}\nF12 — инструменты разработчика`;
    $('#about').style.whiteSpace = 'pre-line';
}

// =========================================================
//  Музыка
// =========================================================
let musicOk = false, fadeRaf = 0;
function fadeMusic(on) {
    const m = $('#music');
    if (!musicOk) return;
    cancelAnimationFrame(fadeRaf);
    const target = on ? settings.musicVol / 100 : 0;
    if (on && m.paused) { m.volume = 0; m.play().catch(() => {}); }
    const step = () => {
        const d = target - m.volume;
        if (Math.abs(d) < 0.01) { m.volume = target; if (!on) m.pause(); return; }
        m.volume = Math.max(0, Math.min(1, m.volume + d * 0.06));
        fadeRaf = requestAnimationFrame(step);
    };
    step();
}

// =========================================================
//  Эффекты: блик стекла, наклон логотипа, подсказки, звуки наведения
// =========================================================
function bindEffects() {
    $$('.glass').forEach(el => el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }));

    const lw = $('#logoWrap');
    lw.addEventListener('mousemove', (e) => {
        const r = lw.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        lw.style.setProperty('--ry', `${x * 14}deg`); lw.style.setProperty('--rx', `${-y * 14}deg`);
    });
    lw.addEventListener('mouseleave', () => { lw.style.setProperty('--ry', '0deg'); lw.style.setProperty('--rx', '0deg'); });
    lw.addEventListener('click', () => {
        lw.classList.remove('drop', 'bounce'); void lw.offsetWidth; lw.classList.add('bounce');
        runShine(); Sfx.play('pop'); pickSplash(); showSplash();
    });

    const tip = $('#tooltip'); let tipTimer = null;
    document.addEventListener('mouseover', (e) => {
        const t = e.target.closest('[data-tip]');
        clearTimeout(tipTimer);
        if (!t || !t.dataset.tip) { tip.classList.remove('show'); return; }
        tipTimer = setTimeout(() => {
            tip.textContent = t.dataset.tip;
            const r = t.getBoundingClientRect();
            tip.classList.add('show');
            const w = tip.offsetWidth, h = tip.offsetHeight;
            let x = r.left + r.width / 2 - w / 2, y = r.top - h - 10;
            if (y < 8) y = r.bottom + 10;
            tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + 'px';
            tip.style.top = y + 'px';
        }, 380);
    });

    $$('button, .seg, .field, .toggle-row').forEach(el => el.addEventListener('mouseenter', () => Sfx.play('hover')));
}

// Блик по логотипу: полоса света, обрезанная по форме логотипа (рисуем на canvas)
let shineRaf = 0;
function runShine() {
    const img = $('#logo'), cv = $('#logoShine');
    if (!img.complete || !img.naturalWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const W = img.clientWidth, H = img.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    cancelAnimationFrame(shineRaf);
    const start = performance.now(), dur = 1300;
    const frame = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const x = (-0.4 + e * 1.8) * cv.width;
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        g.globalCompositeOperation = 'source-in';
        const band = cv.width * 0.11;
        const gr = g.createLinearGradient(x - band, 0, x + band * 0.6, cv.height);
        gr.addColorStop(0, 'rgba(255,255,255,0)');
        gr.addColorStop(0.5, 'rgba(255,255,255,0.6)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(0, 0, cv.width, cv.height);
        if (t < 1) shineRaf = requestAnimationFrame(frame); else g.clearRect(0, 0, cv.width, cv.height);
    };
    shineRaf = requestAnimationFrame(frame);
}

// =========================================================
//  Запуск лаунчера
// =========================================================
async function boot() {
    subscribe();
    state.info = await pvl.init();
    state.config = state.info.config;
    state.builds = state.info.builds;
    state.hw = state.info.hardware || null;
    const assets = state.info.assets || {};

    Sfx.setEnabled(settings.sfx);
    Sfx.setVolume(settings.sfxVol / 100);
    Sfx.loadCustom(assets.sounds);
    if (assets.font) {
        new FontFace('MinecraftSplash', "url('../../assets/fonts/minecraft.ttf')").load()
            .then((f) => document.fonts.add(f)).catch((e) => report('error', 'Шрифт minecraft.ttf: ' + e.message));
    }
    const mode3d = SkinView.init($('#skinCanvas'), $('#fxCanvas'));
    SkinView.setDefault(state.info.defaultSkin);
    report('info', `Скин: режим ${mode3d}${window.skinview3d ? '' : ' (skinview3d не загрузился)'} · выбор сборки: ${settings.buildMode} → ${effectiveBuild().toUpperCase()}`);
    try { Celebrate.init($('#heartsCanvas'), $('#fwCanvas')); } catch (e) { report('error', 'Celebrate: ' + e.message); }

    $$('.reveal').forEach((el, i) => el.style.setProperty('--i', i));
    renderNews();
    renderBuilds();
    bindSettings();
    bindEffects();
    idlePlay();
    pickSplash();

    // Кнопки
    $('#btnMin').onclick = () => { Sfx.play('tap'); pvl.minimize(); };
    $('#btnClose').onclick = () => pvl.close();
    $('#btnSettings').onclick = () => openSettings();
    $('#btnCloseSettings').onclick = () => { Sfx.play('tap'); closeSettings(); };
    $('#scrim').onclick = closeSettings;
    $('#btnCloseConsole').onclick = () => { Sfx.play('tap'); closeConsole(); };
    $('#btnCopyLog').onclick = () => { pvl.copy(state.logLines.join('\n')); Sfx.play('success'); toast('Журнал скопирован', 'ok', null, 2200); };
    $('#play').onclick = () => play(false);
    $$('#buildPicker .seg').forEach(b => b.onclick = () => selectBuild(b.dataset.build));
    $('#nick').addEventListener('input', nickChanged);
    $('#nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') play(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closeConsole(); } });
    document.addEventListener('pointerdown', () => Sfx.unlock(), { once: true });

    // Ник и скин
    const nick = store.get('nick', '');
    $('#nick').value = nick;
    if (NICK_RE.test(nick)) loadSkin(nick, false); else SkinView.set(null, false);

    // Музыка (если есть assets/music.mp3)
    const m = $('#music');
    if (assets.music) {
        m.addEventListener('canplay', () => { if (!musicOk) { musicOk = true; if (!state.inGame) setTimeout(() => fadeMusic(true), 1200); } }, { once: true });
        m.addEventListener('error', () => { $('#musicRow').classList.add('hidden'); report('error', 'music.mp3 не воспроизводится'); }, { once: true });
        m.src = '../../assets/music.mp3';
    } else $('#musicRow').classList.add('hidden');

    // Фоновое видео: сначала WebM, потом MP4; если ни одно не играет — остаётся градиент
    const v = $('#bgVideo');
    v.addEventListener('playing', () => report('info', `Фон: играет ${String(v.currentSrc).split('/').pop()} ${v.videoWidth}×${v.videoHeight}`), { once: true });
    const lastSrc = v.querySelector('source:last-of-type');
    if (lastSrc) lastSrc.addEventListener('error', () => { report('error', 'Фоновое видео не воспроизводится — показываю градиент'); v.classList.add('hidden'); });
    v.addEventListener('error', () => report('error', 'video error: ' + (v.error && v.error.code)));

    // Вступление
    const start = () => {
        if (document.body.classList.contains('ready')) return;
        document.body.classList.remove('booting');
        document.body.classList.add('ready');
        document.dispatchEvent(new Event('pvl:intro'));
        setTimeout(placeIndicator, 50);
        Sfx.play('whoosh');
        setTimeout(() => { $('#logoWrap').classList.add('drop'); }, 320);
        setTimeout(() => { Sfx.play('pop'); }, 820);
        setTimeout(runShine, 1350);
        setTimeout(() => { $('#logoWrap').classList.add('shown'); showSplash(); }, 1500);
    };
    if (v.readyState >= 2) start(); else { v.addEventListener('canplay', start, { once: true }); setTimeout(start, 900); }

    // Свежие новости и настройки с GitHub
    pvl.refreshConfig().then((r) => {
        if (!r) return;
        const firstTime = !state.config || !state.config.hasConfig;
        state.config = r.config; state.builds = r.builds; if (r.hardware) state.hw = r.hardware;
        renderNews(); renderBuilds(); idlePlay();
        if (firstTime) pickSplash();
        updateServer();
    }).catch(() => {});

    updateServer();
    setInterval(() => { if (!document.hidden) updateServer(); }, 30000);
}

boot().catch((e) => {
    report('error', 'boot: ' + (e && e.stack || e));
    document.body.classList.remove('booting');
    document.body.classList.add('ready');
    toast('Ошибка интерфейса: ' + e.message, 'error', null, 10000);
});

})();
