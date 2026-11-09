// Пасхалка: особый ник → лаунчер сыпет сердечками, а за 3D-скином взрывается салют.
// Ники — в app.js (EASTER_NICKS). Всё рисуется на двух canvas и само останавливается, когда ник меняют.
'use strict';

window.Celebrate = (() => {
    const HEART_COLORS = ['#ff4d8d', '#ff6fa8', '#ff8fc0', '#ff3b6b', '#ffb3d1', '#ff2e63', '#ffd1e3'];
    const FW_PALETTES = [
        ['#ff4d8d', '#ff9ac4', '#ffffff'],
        ['#ffd166', '#ffb703', '#fff3c4'],
        ['#5fe1ff', '#2f86ff', '#e6f9ff'],
        ['#b388ff', '#7c4dff', '#f3e8ff'],
        ['#ff5d5d', '#ff9f43', '#ffe0b3'],
        ['#7dffb2', '#3ddc84', '#eafff3']
    ];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = (a) => a[(Math.random() * a.length) | 0];

    let active = false, startedAt = 0;
    let hearts = null, fw = null;

    // ---------- Канвас с правильной плотностью пикселей ----------
    function setup(c) {
        const g = c.getContext('2d');
        const fit = () => {
            const dpr = window.devicePixelRatio || 1;
            c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        fit();
        return { c, g, fit, w: () => c.clientWidth, h: () => c.clientHeight };
    }

    function heartPath(g, s) {
        // сердечко размером ~s, центр в (0,0)
        g.beginPath();
        g.moveTo(0, s * 0.32);
        g.bezierCurveTo(-s * 0.62, -s * 0.08, -s * 0.42, -s * 0.62, 0, -s * 0.3);
        g.bezierCurveTo(s * 0.42, -s * 0.62, s * 0.62, -s * 0.08, 0, s * 0.32);
        g.closePath();
    }
    // пиксельное сердечко, как в Minecraft
    const PIX = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
    function pixelHeart(g, s, color) {
        const p = s / 7;
        g.fillStyle = color;
        for (let y = 0; y < PIX.length; y++) for (let x = 0; x < 7; x++) if (PIX[y][x] === '1') g.fillRect((x - 3.5) * p, (y - 3) * p, p + 0.3, p + 0.3);
        g.fillStyle = 'rgba(255,255,255,.55)';
        g.fillRect(-2.5 * p, -2 * p, p, p);
    }

    // =========================================================
    //  Сердечки на всё окно
    // =========================================================
    function createHearts(canvas) {
        const v = setup(canvas);
        let list = [], raf = 0, last = 0, acc = 0;

        function spawnRain() {
            const size = rnd(12, 30);
            list.push({
                x: rnd(-20, v.w() + 20), y: -30, vx: rnd(-15, 15), vy: rnd(55, 140), g: 0,
                size, rot: rnd(-0.5, 0.5), vr: rnd(-1, 1), sway: rnd(0.6, 1.6), ph: rnd(0, 6.28),
                color: pick(HEART_COLORS), pixel: Math.random() < 0.3, t: 0, life: 99
            });
        }
        function burst(cx, cy, n = 34) {
            for (let i = 0; i < n; i++) {
                const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05), sp = rnd(180, 460);
                list.push({
                    x: cx + rnd(-30, 30), y: cy + rnd(-40, 40), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 420,
                    size: rnd(12, 26), rot: rnd(-0.6, 0.6), vr: rnd(-3, 3), sway: 0, ph: 0,
                    color: pick(HEART_COLORS), pixel: Math.random() < 0.35, t: 0, life: rnd(1.6, 2.6)
                });
            }
            run();
        }

        function frame(now) {
            const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
            const W = v.w(), H = v.h(), g = v.g;
            if (active) {
                const since = (now - startedAt) / 1000;
                const rate = since < 4 ? 16 : since < 9 ? 6 : 2.2;    // сначала ливень, потом тихо сыплются
                acc += rate * dt;
                while (acc >= 1) { acc -= 1; spawnRain(); }
            }
            g.clearRect(0, 0, W, H);
            for (const p of list) {
                p.t += dt;
                p.vy += p.g * dt;
                p.x += (p.vx + Math.sin(p.t * p.sway * 2 + p.ph) * 28 * p.sway) * dt;
                p.y += p.vy * dt;
                p.rot += p.vr * dt;
                const fadeIn = Math.min(1, p.t * 4);
                const fadeOut = p.life < 99 ? Math.max(0, 1 - Math.pow(p.t / p.life, 3)) : Math.max(0, Math.min(1, (H + 10 - p.y) / 80));
                const a = fadeIn * fadeOut;
                if (a <= 0) continue;
                g.save();
                g.globalAlpha = a * 0.95;
                g.translate(p.x, p.y); g.rotate(p.rot);
                const beat = 1 + Math.sin(p.t * 7 + p.ph) * 0.06;
                g.scale(beat, beat);
                if (p.pixel) pixelHeart(g, p.size, p.color);
                else {
                    g.shadowColor = p.color; g.shadowBlur = 10;
                    heartPath(g, p.size);
                    const gr = g.createLinearGradient(0, -p.size * 0.5, 0, p.size * 0.4);
                    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.25, p.color); gr.addColorStop(1, p.color);
                    g.fillStyle = gr; g.fill();
                }
                g.restore();
            }
            list = list.filter(p => (p.life < 99 ? p.t < p.life : p.y < H + 40));
            if (active || list.length) raf = requestAnimationFrame(frame);
            else { raf = 0; g.clearRect(0, 0, W, H); }
        }
        function run() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
        return { run, burst, fit: v.fit };
    }

    // =========================================================
    //  Салют за скином
    // =========================================================
    function createFireworks(canvas) {
        const v = setup(canvas);
        let rockets = [], sparks = [], raf = 0, last = 0, nextAt = 0, shots = 0;

        function launch() {
            const W = v.w(), H = v.h();
            rockets.push({
                x: rnd(W * 0.18, W * 0.82), y: H + 6, vx: rnd(-30, 30), vy: rnd(-430, -340),
                pal: pick(FW_PALETTES), heart: Math.random() < 0.3, trail: []
            });
            shots++;
            if (soundOn()) Sfx.play('launch');
        }

        function explode(r) {
            const n = r.heart ? 70 : 90;
            for (let i = 0; i < n; i++) {
                let vx, vy;
                if (r.heart) {
                    // частицы ложатся в форму сердца
                    const t = (i / n) * Math.PI * 2;
                    const hx = 16 * Math.pow(Math.sin(t), 3);
                    const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
                    const k = rnd(7.2, 8.2);
                    vx = hx * k; vy = hy * k;
                } else {
                    const a = rnd(0, Math.PI * 2), sp = rnd(60, 190) * (Math.random() < 0.15 ? 1.3 : 1);
                    vx = Math.cos(a) * sp; vy = Math.sin(a) * sp;
                }
                sparks.push({
                    x: r.x, y: r.y, vx, vy, color: pick(r.pal), size: rnd(1.6, 3),
                    t: 0, life: rnd(1.1, 1.9), glitter: Math.random() < 0.35
                });
            }
            // вспышка
            sparks.push({ x: r.x, y: r.y, vx: 0, vy: 0, color: '#ffffff', size: 22, t: 0, life: 0.18, flash: true });
            if (soundOn()) { Sfx.play('boom'); setTimeout(() => Sfx.play('crackle'), 380); }
        }

        function soundOn() { return window.Sfx && performance.now() - startedAt < 12000; }

        function frame(now) {
            const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
            const W = v.w(), H = v.h(), g = v.g;
            if (active && now >= nextAt) {
                launch();
                if (shots < 6 && Math.random() < 0.45) launch();
                const since = (now - startedAt) / 1000;
                nextAt = now + (since < 7 ? rnd(380, 650) : rnd(1500, 2800));
            }
            // шлейф: прошлый кадр медленно гаснет
            g.globalCompositeOperation = 'destination-out';
            g.fillStyle = 'rgba(0,0,0,0.22)';
            g.fillRect(0, 0, W, H);
            g.globalCompositeOperation = 'lighter';

            for (const r of rockets) {
                r.vy += 260 * dt; r.x += r.vx * dt; r.y += r.vy * dt;
                g.fillStyle = 'rgba(255,230,190,.9)';
                g.beginPath(); g.arc(r.x, r.y, 2, 0, 6.283); g.fill();
                g.fillStyle = 'rgba(255,190,120,.35)';
                g.beginPath(); g.arc(r.x - r.vx * 0.02, r.y - r.vy * 0.02, 1.6, 0, 6.283); g.fill();
                if (r.vy > -60 || r.y < H * 0.22) { r.done = true; explode(r); }
            }
            rockets = rockets.filter(r => !r.done);

            for (const s of sparks) {
                s.t += dt;
                if (!s.flash) {
                    s.vy += 70 * dt; s.vx *= 0.975; s.vy *= 0.975;
                    s.x += s.vx * dt; s.y += s.vy * dt;
                }
                const k = s.t / s.life;
                let a = Math.max(0, 1 - k * k);
                if (s.glitter && k > 0.45) a *= Math.random() < 0.5 ? 1 : 0.15;
                if (a <= 0) continue;
                g.globalAlpha = a;
                if (s.flash) {
                    const gr = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * (1 + k * 2));
                    gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
                    g.fillStyle = gr; g.beginPath(); g.arc(s.x, s.y, s.size * (1 + k * 2), 0, 6.283); g.fill();
                } else {
                    g.fillStyle = s.color;
                    g.beginPath(); g.arc(s.x, s.y, s.size * (1 - k * 0.5), 0, 6.283); g.fill();
                }
            }
            g.globalAlpha = 1;
            g.globalCompositeOperation = 'source-over';
            sparks = sparks.filter(s => s.t < s.life);

            if (active || rockets.length || sparks.length) raf = requestAnimationFrame(frame);
            else { raf = 0; g.clearRect(0, 0, W, H); }
        }
        return {
            run() { nextAt = performance.now() + 250; shots = 0; if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } },
            fit: v.fit
        };
    }

    return {
        init(heartsCanvas, fwCanvas) {
            hearts = createHearts(heartsCanvas);
            fw = createFireworks(fwCanvas);
        },
        // fromX/fromY — откуда вылетает первый «фонтан» сердечек (центр скина)
        start(fromX, fromY) {
            if (!hearts || active) return;
            active = true; startedAt = performance.now();
            hearts.fit(); fw.fit();
            document.body.classList.add('celebrate');
            if (fromX != null) hearts.burst(fromX, fromY);
            hearts.run(); fw.run();
            window.Sfx && Sfx.play('love');
        },
        stop() {
            if (!active) return;
            active = false;
            document.body.classList.remove('celebrate');
        },
        isActive: () => active
    };
})();
