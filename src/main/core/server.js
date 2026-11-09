// Статус сервера: свой пинг по протоколу Minecraft (быстро, без посредников),
// запасной вариант — api.mcstatus.io.
'use strict';
const net = require('net');
const axios = require('axios');

function varInt(n) {
    const out = [];
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
    return Buffer.from(out);
}
function readVarInt(buf, off) {
    let num = 0, shift = 0, b;
    do {
        if (off >= buf.length) return null;
        b = buf[off++]; num |= (b & 0x7f) << shift; shift += 7;
        if (shift > 35) throw new Error('bad varint');
    } while (b & 0x80);
    return { value: num, off };
}
function packet(id, payload) {
    const body = Buffer.concat([varInt(id), payload]);
    return Buffer.concat([varInt(body.length), body]);
}
function motdText(d) {
    if (!d) return '';
    if (typeof d === 'string') return d.replace(/§./g, '');
    let s = d.text || '';
    if (Array.isArray(d.extra)) s += d.extra.map(motdText).join('');
    return s.replace(/§./g, '');
}

function slp(host, port, timeout = 6000) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ host, port });
        let buf = Buffer.alloc(0), done = false, started = 0;
        const end = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
        sock.setTimeout(timeout, () => end(new Error('timeout')));
        sock.on('error', end);
        sock.on('connect', () => {
            const hostBuf = Buffer.from(host, 'utf8');
            const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
            sock.write(packet(0x00, Buffer.concat([varInt(767), varInt(hostBuf.length), hostBuf, portBuf, varInt(1)])));
            started = Date.now();
            sock.write(packet(0x00, Buffer.alloc(0)));
        });
        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            try {
                const len = readVarInt(buf, 0); if (!len) return;
                if (buf.length < len.off + len.value) return;
                const id = readVarInt(buf, len.off);
                const sl = readVarInt(buf, id.off);
                const json = JSON.parse(buf.subarray(sl.off, sl.off + sl.value).toString('utf8'));
                end(null, {
                    online: true,
                    ping: Date.now() - started,
                    players: { online: json.players?.online ?? 0, max: json.players?.max ?? 0,
                               list: (json.players?.sample || []).map(p => p.name).filter(Boolean) },
                    version: json.version?.name || null,
                    motd: motdText(json.description),
                    icon: typeof json.favicon === 'string' && json.favicon.startsWith('data:image/') ? json.favicon : null
                });
            } catch (e) { end(e); }
        });
    });
}

async function status(address) {
    if (typeof address !== 'string' || !/^[a-zA-Z0-9.\-]+(:\d{1,5})?$/.test(address)) return { online: false, error: 'bad address' };
    const [host, p] = address.split(':');
    const port = parseInt(p || '25565', 10);
    try {
        return await slp(host, port);
    } catch (e) {
        try {
            const res = await axios.get(`https://api.mcstatus.io/v2/status/java/${address}`, { timeout: 8000 });
            const d = res.data || {};
            return {
                online: !!d.online, ping: null,
                players: d.players ? { online: d.players.online, max: d.players.max, list: (d.players.list || []).map(x => x.name_clean) } : null,
                version: d.version ? d.version.name_clean : null,
                motd: d.motd ? d.motd.clean : '',
                icon: d.icon || null
            };
        } catch {
            return { online: false, error: e.message };
        }
    }
}

module.exports = { status };
