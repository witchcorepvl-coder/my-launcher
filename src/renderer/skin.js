// 3D-модель скина (skinview3d) + эффект частиц при смене скина.
// Если 3D недоступно (нет WebGL или библиотеки) — показываем скин в 2D, всё остальное работает.
'use strict';

window.SkinView = (() => {
    let viewer = null, canvas = null, ctx2d = null, fx = null;
    let current = null;          // { skin, slim, cape }
    let fallback = null;         // скин по умолчанию из assets/default-skin.png (присылает главный процесс)
    let mode = 'none';
    let spinning = false;
    let swayStart = performance.now();

    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    // ---------- Частицы ----------
    function createFx(c) {
        const g = c.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
        g.scale(dpr, dpr);
        let parts = [], rings = [], raf = 0, last = 0;

        function loop(now) {
            const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
            g.clearRect(0, 0, c.clientWidth, c.clientHeight);
            for (const r of rings) {
                r.t += dt; const k = r.t / r.life;
                if (k >= 1) continue;
                g.beginPath(); g.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * ease(k), 0, Math.PI * 2);
                g.strokeStyle = `rgba(150,230,255,${0.55 * (1 - k)})`; g.lineWidth = 3 * (1 - k) + 0.5; g.stroke();
            }
            rings = rings.filter(r => r.t < r.life);
            for (const p of parts) {
                p.t += dt;
                p.vy += p.g * dt; p.vx *= 0.985; p.vy *= 0.985;
                p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
                const k = p.t / p.life;
                g.save();
                g.globalAlpha = Math.max(0, 1 - k * k);
                g.translate(p.x, p.y); g.rotate(p.rot);
                if (p.spark) {
                    g.fillStyle = p.color; const s = p.size * (1 - k * 0.6);
                    g.fillRect(-s / 2, -0.8, s, 1.6); g.fillRect(-0.8, -s / 2, 1.6, s);
                } else {
                    g.fillStyle = p.color; g.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
                    g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.3);
                }
                g.restore();
            }
            parts = parts.filter(p => p.t < p.life);
            if (parts.length || rings.length) raf = requestAnimationFrame(loop);
            else { raf = 0; g.clearRect(0, 0, c.clientWidth, c.clientHeight); }
        }

        return {
            burst(colors, cx, cy) {
                const pal = colors && colors.length ? colors : ['#5fe1ff', '#2f86ff', '#ffffff'];
                for (let i = 0; i < 95; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const sp = 140 + Math.random() * 300;
                    parts.push({
                        x: cx + (Math.random() - 0.5) * 70, y: cy + (Math.random() - 0.5) * 150,
                        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140,
                        g: 520, size: 3 + Math.random() * 6, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10,
                        color: pal[(Math.random() * pal.length) | 0], t: 0, life: 0.8 + Math.random() * 0.7
                    });
                }
                for (let i = 0; i < 26; i++) {
                    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
                    parts.push({
                        x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, g: -30,
                        size: 7 + Math.random() * 7, rot: 0, vr: 0, spark: true,
                        color: Math.random() < 0.5 ? '#ffffff' : '#9eeeff', t: 0, life: 0.6 + Math.random() * 0.6
                    });
                }
                rings.push({ x: cx, y: cy + 20, r0: 20, r1: 190, t: 0, life: 0.7 });
                if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
            }
        };
    }

    // Цвета из нового скина — частицы будут «из него»
    function sampleColors(dataUrl) {
        return new Promise((resolve) => {
            if (!dataUrl) return resolve([]);
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas'); c.width = 64; c.height = 64;
                const g = c.getContext('2d'); g.drawImage(img, 0, 0);
                const regions = [[8, 8, 8, 8], [20, 20, 8, 12], [44, 20, 4, 12], [4, 20, 4, 12]];
                const out = [];
                for (const [x, y, w, h] of regions) {
                    const d = g.getImageData(x, y, w, h).data;
                    for (let i = 0; i < d.length; i += 4 * 3) if (d[i + 3] > 200) out.push(`rgb(${d[i]},${d[i + 1]},${d[i + 2]})`);
                }
                resolve(out);
            };
            img.onerror = () => resolve([]);
            img.src = dataUrl;
        });
    }

    // Простой стандартный скин, если ничего не удалось загрузить
    function makeDefaultSkin() {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const g = c.getContext('2d');
        const r = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
        r('#c58e6b', 0, 0, 32, 16);           // голова
        r('#3b2a1e', 8, 0, 8, 8); r('#3b2a1e', 0, 8, 32, 2);   // волосы
        r('#ffffff', 9, 12, 2, 1); r('#3d5cff', 10, 12, 1, 1); r('#ffffff', 13, 12, 2, 1); r('#3d5cff', 13, 12, 1, 1);
        r('#7a4a35', 11, 14, 2, 1);
        r('#2fb6d6', 16, 16, 24, 16); r('#2fb6d6', 40, 16, 16, 16); r('#2fb6d6', 32, 48, 16, 16);  // футболка/руки
        r('#c58e6b', 44, 28, 4, 4); r('#c58e6b', 36, 60, 4, 4);
        r('#3346a8', 0, 16, 16, 16); r('#3346a8', 16, 48, 16, 16);   // штаны
        r('#555555', 4, 28, 4, 4); r('#555555', 20, 60, 4, 4);
        return c.toDataURL();
    }

    // ---------- 2D-запасной вариант ----------
    function draw2D(dataUrl) {
        const img = new Image();
        img.onload = () => {
            const W = canvas.width, H = canvas.height; ctx2d.clearRect(0, 0, W, H);
            ctx2d.imageSmoothingEnabled = false;
            const s = Math.floor((H - 20) / 32), ox = W / 2 - 8 * s, oy = (H - 32 * s) / 2;
            const part = (sx, sy, w, h, dx, dy) => ctx2d.drawImage(img, sx, sy, w, h, ox + dx * s, oy + dy * s, w * s, h * s);
            const slim = current && current.slim;
            part(8, 8, 8, 8, 4, 0); part(40, 8, 8, 8, 4, 0);                // голова + слой
            part(20, 20, 8, 12, 4, 8); part(20, 36, 8, 12, 4, 8);           // тело
            part(44, 20, slim ? 3 : 4, 12, slim ? 1 : 0, 8);                   // правая рука
            part(36, 52, slim ? 3 : 4, 12, 12, 8);                             // левая рука
            part(4, 20, 4, 12, 4, 20); part(20, 52, 4, 12, 8, 20);           // ноги
            part(4, 36, 4, 12, 4, 20); part(4, 52, 4, 12, 8, 20);
        };
        img.src = dataUrl;
    }

    async function apply(s) {
        if (mode === '3d') {
            await viewer.loadSkin(s.skin, { model: s.slim ? 'slim' : 'default' });
            if (s.cape) await viewer.loadCape(s.cape); else viewer.resetCape();
        } else if (mode === '2d') {
            draw2D(s.skin);
        }
    }

    // Мягкое покачивание модели, когда её не крутят
    function sway(now) {
        if (viewer && !spinning) viewer.playerObject.rotation.y = Math.sin((now - swayStart) / 2200) * 0.35;
        requestAnimationFrame(sway);
    }

    return {
        init(skinCanvas, fxCanvas) {
            canvas = skinCanvas;
            fx = createFx(fxCanvas);
            try {
                if (!window.skinview3d) throw new Error('no lib');
                viewer = new skinview3d.SkinViewer({ canvas, width: 300, height: 296 });
                viewer.background = null;
                viewer.fov = 40;
                viewer.zoom = 0.86;
                viewer.controls.enableZoom = false;
                viewer.controls.enablePan = false;
                viewer.animation = new skinview3d.WalkingAnimation();
                viewer.animation.speed = 0.6;
                mode = '3d';
                requestAnimationFrame(sway);
            } catch (e) {
                mode = '2d';
                ctx2d = canvas.getContext('2d');
                canvas.classList.add('flat');
            }
            return mode;
        },

        // Сменить скин. animate=false — тихо (при запуске).
        async set(s, animate = true) {
            if (!s || !s.skin) s = { skin: fallback || makeDefaultSkin(), slim: false, cape: null };
            if (current && current.skin === s.skin && current.slim === s.slim) return;
            const first = !current;
            current = s;
            if (!animate || first) { await apply(s); return; }

            const colors = await sampleColors(s.skin);
            spinning = true;
            const start = performance.now(), dur = 950;
            const baseY = viewer ? viewer.playerObject.rotation.y : 0;
            let swapped = false;
            await new Promise((resolve) => {
                const step = async (now) => {
                    const t = Math.min(1, (now - start) / dur), e = ease(t);
                    if (viewer) {
                        viewer.playerObject.rotation.y = baseY + e * Math.PI * 2;
                        viewer.playerObject.position.y = Math.sin(t * Math.PI) * 4;
                        const sc = 1 - Math.sin(t * Math.PI) * 0.12;
                        viewer.playerObject.scale.set(sc, 1 + (1 - sc) * 0.5, sc);
                    } else {
                        canvas.style.transform = `perspective(600px) rotateY(${e * 360}deg) translateY(${-Math.sin(t * Math.PI) * 14}px)`;
                    }
                    if (!swapped && t >= 0.42) {
                        swapped = true;
                        apply(s).catch(() => {});
                        const r = canvas.getBoundingClientRect(), f = document.getElementById('fxCanvas').getBoundingClientRect();
                        fx.burst(colors, r.left - f.left + r.width / 2, r.top - f.top + r.height / 2);
                        window.Sfx && Sfx.play('sparkle');
                    }
                    if (t < 1) requestAnimationFrame(step);
                    else {
                        if (viewer) { viewer.playerObject.position.y = 0; viewer.playerObject.scale.set(1, 1, 1); }
                        else canvas.style.transform = '';
                        resolve();
                    }
                };
                requestAnimationFrame(step);
            });
            // продолжаем покачивание с того же угла, без рывка
            const k = Math.max(-1, Math.min(1, baseY / 0.35));
            swayStart = performance.now() - Math.asin(k) * 2200;
            spinning = false;
        },

        // Маленькая «радость», например при запуске игры
        cheer() {
            if (viewer && skinview3d.WaveAnimation) {
                viewer.animation = new skinview3d.WaveAnimation();
                setTimeout(() => { if (viewer) { viewer.animation = new skinview3d.WalkingAnimation(); viewer.animation.speed = 0.6; } }, 2600);
            }
        },
        setDefault(dataUrl) { if (dataUrl) fallback = dataUrl; },
        mode: () => mode
    };
})();
