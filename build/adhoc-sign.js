// Бесплатная ad-hoc подпись приложения для macOS.
// Без любой подписи Mac на Apple Silicon (M1–M4) пишет «приложение повреждено».
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
    if (context.electronPlatformName !== 'darwin') return;
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    console.log(`  • ad-hoc подпись: ${appPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
