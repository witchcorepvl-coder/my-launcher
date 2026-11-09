// Звуки интерфейса — синтезируются на лету (Web Audio), без аудиофайлов.
// Хочешь свой звук — положи файл в assets/sounds/<имя>.mp3 (имена: hover, tap, toggle, error, success, whoosh, sparkle, pop,
// для пасхалки: love, launch, boom, crackle),
// и он будет играть вместо синтеза.
'use strict';

window.Sfx = (() => {
    let ctx = null, master = null;
    let enabled = true, volume = 0.6;
    const custom = {};     // свои файлы из assets/sounds
    let lastHover = 0;

    function ensure() {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            master = ctx.createGain();
            master.gain.value = volume;
            const comp = ctx.createDynamicsCompressor();
            master.connect(comp); comp.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    // Один тон с огибающей
    function tone({ f = 800, f2 = null, dur = 0.08, type = 'sine', gain = 0.2, attack = 0.004, delay = 0, q = null }) {
        const c = ensure(), t = c.currentTime + delay;
        const o = c.createOscillator(), g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f, t);
        if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        let node = o;
        if (q) { const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = q; o.connect(fl); node = fl; }
        node.connect(g); g.connect(master);
        o.start(t); o.stop(t + dur + 0.02);
    }

    // Шум (для «вжух»)
    function noise({ dur = 0.5, from = 400, to = 2400, gain = 0.12, delay = 0, type = 'bandpass', q = 1.4, attack = 0.35 }) {
        const c = ensure(), t = c.currentTime + delay;
        const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = c.createBufferSource(); src.buffer = buf;
        const bp = c.createBiquadFilter(); bp.type = type; bp.Q.value = q;
        bp.frequency.setValueAtTime(from, t); bp.frequency.exponentialRampToValueAtTime(to, t + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + dur * attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(bp); bp.connect(g); g.connect(master);
        src.start(t);
    }

    const synth = {
        hover() { tone({ f: 2200, dur: 0.03, type: 'triangle', gain: 0.025 }); },
        tap() { tone({ f: 1050, f2: 640, dur: 0.075, gain: 0.11 }); tone({ f: 3200, dur: 0.012, type: 'triangle', gain: 0.03 }); },
        toggle(on) {
            const [a, b] = on ? [660, 990] : [880, 590];
            tone({ f: a, dur: 0.06, gain: 0.08 }); tone({ f: b, dur: 0.08, gain: 0.08, delay: 0.055 });
        },
        error() { tone({ f: 190, f2: 120, dur: 0.16, type: 'square', gain: 0.07, q: 900 }); tone({ f: 170, f2: 110, dur: 0.18, type: 'square', gain: 0.06, q: 900, delay: 0.12 }); },
        success() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ f, dur: 0.55, gain: 0.055, attack: 0.02, delay: i * 0.06 })); },
        whoosh() { noise({ dur: 0.7, from: 300, to: 2600, gain: 0.07 }); },
        sparkle() { [1318.5, 1568, 2093, 2637].forEach((f, i) => tone({ f, dur: 0.22, type: 'triangle', gain: 0.04, delay: i * 0.045 })); },
        pop() { tone({ f: 320, f2: 880, dur: 0.09, gain: 0.08 }); },
        // пасхалка: сердечки и салют
        love() { [659.25, 830.6, 987.8, 1318.5, 1661.2].forEach((f, i) => tone({ f, dur: 0.6, type: 'triangle', gain: 0.05, attack: 0.02, delay: i * 0.09 })); },
        launch() { tone({ f: 500, f2: 1500, dur: 0.45, type: 'sine', gain: 0.018, attack: 0.05 }); noise({ dur: 0.4, from: 1200, to: 3000, gain: 0.015 }); },
        boom() { noise({ dur: 0.9, from: 900, to: 90, gain: 0.16, type: 'lowpass', q: 0.7, attack: 0.02 }); tone({ f: 90, f2: 40, dur: 0.5, gain: 0.08, attack: 0.005 }); },
        crackle() { for (let i = 0; i < 9; i++) noise({ dur: 0.04, from: 3000, to: 5000, gain: 0.03 + Math.random() * 0.03, delay: i * 0.05 + Math.random() * 0.06, attack: 0.1 }); }
    };

    function play(name, ...args) {
        if (!enabled || volume <= 0) return;
        if (name === 'hover') { const n = performance.now(); if (n - lastHover < 60) return; lastHover = n; }
        try {
            if (custom[name]) { const a = custom[name].cloneNode(); a.volume = Math.min(1, volume); a.play().catch(() => {}); return; }
            synth[name] && synth[name](...args);
        } catch {}
    }

    // Подхватываем свои файлы (список присылает главный процесс — только те, что реально лежат в assets/sounds)
    function loadCustom(files) {
        for (const f of files || []) {
            const m = /^([a-z]+)\.(mp3|ogg|wav)$/i.exec(f);
            if (!m || !synth[m[1]]) continue;
            const a = new Audio(`../../assets/sounds/${f}`);
            a.preload = 'auto';
            a.addEventListener('canplaythrough', () => { custom[m[1]] = a; }, { once: true });
        }
    }

    return {
        play,
        loadCustom,
        setEnabled(v) { enabled = !!v; },
        setVolume(v) { volume = Math.max(0, Math.min(1, v)); if (master) master.gain.value = volume; },
        unlock() { try { ensure(); } catch {} }
    };
})();
