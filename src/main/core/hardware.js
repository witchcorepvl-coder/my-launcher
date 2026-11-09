// Проверка компьютера: какая видеокарта и сколько памяти → какую сборку ставить автоматически.
// Правило по умолчанию: видеокарта NVIDIA и больше 8 ГБ памяти → FULL, иначе LITE.
// Порог и производителей можно поменять в config.json → "auto_select" (см. README).
'use strict';
const os = require('os');
const { execFile } = require('child_process');
const { app } = require('electron');
const { IS_WIN, IS_MAC } = require('./env');

const VENDORS = {
    nvidia: { ids: [0x10de], re: /nvidia|geforce|quadro|rtx\s?\d|gtx\s?\d|tesla/i },
    amd: { ids: [0x1002, 0x1022], re: /\bamd\b|radeon/i },
    intel: { ids: [0x8086], re: /intel/i },
    apple: { ids: [0x106b], re: /apple/i }
};

function run(cmd, args, ms = 6000) {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 4 * 1048576 }, (err, out) => resolve(err ? '' : String(out || '')));
        } catch { resolve(''); }
    });
}

// Названия видеокарт от системы (Chromium иногда не видит дискретную карту, если она спит)
async function osGpuNames() {
    try {
        if (IS_WIN) {
            let out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }']);
            if (!out.trim()) out = (await run('wmic', ['path', 'win32_VideoController', 'get', 'name'])).replace(/^Name\s*/i, '');
            return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        }
        if (IS_MAC) {
            const out = await run('system_profiler', ['SPDisplaysDataType', '-json'], 8000);
            const data = JSON.parse(out || '{}');
            return (data.SPDisplaysDataType || []).map(g => g.sppci_model || g._name).filter(Boolean);
        }
        const out = await run('lspci', []);
        return out.split('\n').filter(l => /VGA|3D|Display/i.test(l)).map(l => l.replace(/^.*?:\s.*?:\s/, '').trim());
    } catch { return []; }
}

// То, что видит сам Chromium (vendorId надёжнее названия)
async function chromiumGpus() {
    try {
        const info = await Promise.race([
            app.getGPUInfo('basic'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
        ]);
        return (info.gpuDevice || []).map(d => ({
            vendorId: d.vendorId, deviceId: d.deviceId, active: !!d.active,
            name: d.deviceString || d.driverVendor || '', driver: d.driverVersion || ''
        }));
    } catch { return []; }
}

let cached = null;

async function detect() {
    if (cached) return cached;
    const t0 = Date.now();
    const [cg, names] = await Promise.all([chromiumGpus(), osGpuNames()]);
    const ramMB = Math.floor(os.totalmem() / 1048576);
    const vendors = new Set();
    for (const g of cg) for (const [v, d] of Object.entries(VENDORS)) if (d.ids.includes(g.vendorId) || d.re.test(g.name)) vendors.add(v);
    for (const n of names) for (const [v, d] of Object.entries(VENDORS)) if (d.re.test(n)) vendors.add(v);

    const gpuNames = names.length ? names : cg.map(g => g.name || `vendor 0x${(g.vendorId || 0).toString(16)} device 0x${(g.deviceId || 0).toString(16)}`);
    cached = {
        ramMB,
        cpu: (os.cpus()[0] || {}).model || 'неизвестно',
        cores: os.cpus().length,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        gpus: gpuNames,
        gpuRaw: cg,
        vendors: [...vendors],
        tookMs: Date.now() - t0
    };
    return cached;
}

// rule: { min_ram_gb: 8, gpu: ['nvidia'] }
function recommend(hw, rule = {}) {
    const minGb = Number.isFinite(rule.min_ram_gb) ? rule.min_ram_gb : 8;
    const want = Array.isArray(rule.gpu) && rule.gpu.length ? rule.gpu.map(s => String(s).toLowerCase()) : ['nvidia'];
    const ramOk = hw.ramMB > minGb * 1024;
    const gpuOk = hw.vendors.some(v => want.includes(v));
    const build = ramOk && gpuOk ? 'full' : 'lite';
    const why = [];
    why.push(gpuOk ? `видеокарта ${want.join('/').toUpperCase()} есть` : `видеокарты ${want.join('/').toUpperCase()} нет`);
    why.push(`памяти ${(hw.ramMB / 1024).toFixed(1)} ГБ ${ramOk ? '>' : '≤'} ${minGb} ГБ`);
    return { build, ramOk, gpuOk, minGb, want, reason: why.join(', ') };
}

module.exports = { detect, recommend };
