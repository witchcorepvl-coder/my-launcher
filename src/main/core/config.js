// config.json с GitHub: новости, сплэши, адрес сервера, версии и ссылки сборок.
// Последний удачно загруженный конфиг хранится на диске — без интернета лаунчер покажет его.
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { app } = require('electron');
const { CONFIG_SOURCES, DEFAULT_SERVER, BUILDS } = require('./env');
const { normalizeSource, okUrl } = require('./builds');
const log = require('./logger');

const CACHE_FILE = path.join(app.getPath('userData'), 'config-cache.json');
let current = null;      // применённый config.json
let isFresh = false;     // загружен из сети в этом запуске
let savedAt = null;

function apply(data) {
    if (!data || typeof data !== 'object') return;
    current = data;
    if (!data.builds || typeof data.builds !== 'object') return;
    for (const [id, cfg] of Object.entries(data.builds)) {
        const b = BUILDS[id];
        if (!b || !cfg) continue;
        if (okUrl(cfg.url)) b.url = cfg.url;
        const list = Array.isArray(cfg.sources) ? cfg.sources : [cfg.url, ...(Array.isArray(cfg.mirrors) ? cfg.mirrors : [])];
        const norm = list.map(normalizeSource).filter(Boolean);
        if (norm.length) b.sources = norm;
        if (typeof cfg.version === 'string' || typeof cfg.version === 'number') b.version = String(cfg.version);
        if (Number.isFinite(cfg.ram) && cfg.ram >= 2048) b.ramMB = Math.round(cfg.ram);
    }
}

function loadCache() {
    try {
        const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        savedAt = c.savedAt || null;
        apply(c.data);
        log.info(`config: загружен из кэша (${savedAt || 'без даты'})`);
    } catch { log.info('config: кэша ещё нет'); }
}

async function refresh() {
    for (const url of CONFIG_SOURCES) {
        const t0 = Date.now();
        try {
            const res = await axios.get(`${url}?t=${Date.now()}`, { timeout: 8000, responseType: 'text', transformResponse: x => x });
            const data = JSON.parse(res.data);
            if (data && typeof data === 'object') {
                log.info(`config: OK ${url} · HTTP ${res.status} · ${String(res.data).length} байт · ${Date.now() - t0} мс`);
                apply(data);
                for (const b of Object.values(BUILDS)) {
                    log.info(`config: сборка ${b.name} · версия ${b.version || '—'} · память ${b.ramMB} МБ · источники: `
                        + JSON.stringify(b.sources || [b.url]));
                }
                isFresh = true;
                savedAt = new Date().toISOString();
                try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ savedAt, data })); } catch {}
                return true;
            }
        } catch (e) {
            const st = e.response ? `HTTP ${e.response.status}` : (e.code || e.message);
            log.warn(`config: не удалось загрузить ${url} · ${st} · ${Date.now() - t0} мс`);
        }
    }
    log.warn('config: все источники недоступны — работаю по кэшу/встроенным настройкам');
    return false;
}

// То, что нужно интерфейсу
function view() {
    const c = current || {};
    return {
        news: typeof c.news === 'string' ? c.news : null,
        splashes: Array.isArray(c.splashes) ? c.splashes.filter(s => typeof s === 'string' && s.trim()) : null,
        server: typeof c.server_ip === 'string' && c.server_ip.trim() ? c.server_ip.trim() : DEFAULT_SERVER,
        builds: Object.fromEntries(Object.values(BUILDS).map(b => [b.id, { name: b.name, version: b.version || null, ramMB: b.ramMB }])),
        autoSelect: c.auto_select && typeof c.auto_select === 'object' ? c.auto_select : {},
        fromCache: !isFresh,
        hasConfig: !!current,
        savedAt
    };
}

loadCache();
module.exports = { refresh, view, isLoaded: () => isFresh };
