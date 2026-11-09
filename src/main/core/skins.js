// Скины игроков по нику через Mojang. Результат кэшируется на диске на 6 часов.
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { app } = require('electron');

const CACHE_DIR = path.join(app.getPath('userData'), 'skins');
const TTL = 6 * 3600 * 1000;
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;

async function getJson(url) {
    const res = await axios.get(url, { timeout: 8000, validateStatus: () => true });
    if (res.status === 200 && res.data) return res.data;
    if (res.status === 204 || res.status === 404) return null;   // такого ника нет
    throw new Error(`Mojang ответил ${res.status}`);
}

async function toDataUrl(url) {
    const res = await axios.get(url.replace(/^http:/, 'https:'), { responseType: 'arraybuffer', timeout: 10000 });
    return 'data:image/png;base64,' + Buffer.from(res.data).toString('base64');
}

async function fetchFromMojang(nick) {
    let profile = null;
    try {
        profile = await getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`);
    } catch {
        profile = await getJson(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(nick)}`);
    }
    if (!profile || !profile.id) return { found: false };

    const session = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`);
    const prop = session && (session.properties || []).find(p => p.name === 'textures');
    if (!prop) return { found: false };
    const textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures || {};
    if (!textures.SKIN || !textures.SKIN.url) return { found: true, name: profile.name, skin: null };

    const out = {
        found: true,
        name: profile.name,
        slim: !!(textures.SKIN.metadata && textures.SKIN.metadata.model === 'slim'),
        skin: await toDataUrl(textures.SKIN.url),
        cape: null
    };
    if (textures.CAPE && textures.CAPE.url) { try { out.cape = await toDataUrl(textures.CAPE.url); } catch {} }
    return out;
}

async function lookup(nick) {
    if (!NICK_RE.test(nick || '')) return { found: false, invalid: true };
    const file = path.join(CACHE_DIR, `${nick.toLowerCase()}.json`);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (cached && Date.now() - cached.t < TTL) return cached.v;
    try {
        const v = await fetchFromMojang(nick);
        try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ t: Date.now(), v })); } catch {}
        return v;
    } catch (e) {
        if (cached) return cached.v;                 // нет связи — показываем старый
        return { found: false, offline: true, error: e.message };
    }
}

// Стандартный скин для ников, которых нет у Mojang (пиратских)
// Скин по умолчанию — файл assets/default-skin.png (64×64). Нет файла — Стив от Mojang.
function bundledSkin() {
    try {
        const p = require('path').join(__dirname, '../../../assets/default-skin.png');
        const b = require('fs').readFileSync(p);
        return { found: true, name: 'default', slim: false, cape: null, skin: 'data:image/png;base64,' + b.toString('base64') };
    } catch { return null; }
}

async function defaultSkin() {
    const own = bundledSkin();
    if (own) return own;
    const r = await lookup('MHF_Steve');
    return r && r.skin ? r : null;
}

module.exports = { lookup, defaultSkin, bundledSkin };
