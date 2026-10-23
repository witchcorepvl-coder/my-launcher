// Упаковка готовых .app в .dmg штатной утилитой macOS (hdiutil).
// Встроенный упаковщик electron-builder нестабилен на новых macOS у GitHub,
// поэтому делаем dmg сами: по одному, с повтором при сбое.
// В dmg: PavlovskCraft.app + ярлык на «Программы» (Applications).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRODUCT = 'PavlovskCraft';
const dist = path.join(__dirname, '..', 'dist');
const targets = [
    { dir: 'mac-arm64', arch: 'arm64' },   // M1–M4
    { dir: 'mac',       arch: 'x64' }      // Intel
];

const sleep = (sec) => execFileSync('sleep', [String(sec)]);
let made = 0;

for (const { dir, arch } of targets) {
    const app = path.join(dist, dir, `${PRODUCT}.app`);
    if (!fs.existsSync(app)) { console.log(`  • нет ${app}, пропускаю`); continue; }

    const stage = fs.mkdtempSync(path.join(os.tmpdir(), `dmg-${arch}-`));
    // ditto сохраняет подпись и права файлов внутри .app
    execFileSync('ditto', [app, path.join(stage, `${PRODUCT}.app`)], { stdio: 'inherit' });
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));

    const out = path.join(dist, `${PRODUCT}-${arch}.dmg`);
    for (let attempt = 1; ; attempt++) {
        try {
            execFileSync('hdiutil', ['create', '-volname', PRODUCT, '-srcfolder', stage,
                '-ov', '-format', 'UDZO', out], { stdio: 'inherit' });
            break;
        } catch (e) {
            if (attempt >= 4) throw e;
            console.log(`  • hdiutil не справился, попытка ${attempt + 1} через 10 с...`);
            sleep(10);
        }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    console.log(`  • готово: ${out}`);
    made++;
}

if (!made) { console.error('Не найдено ни одного .app для упаковки'); process.exit(1); }
