// Общие настройки лаунчера: пути, версии, адреса.
// Значения сборок здесь — запасные: основное берётся из config.json на GitHub (см. README).
'use strict';
const path = require('path');
const { app } = require('electron');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || 'linux';

// Папка игры. Не меняй: тут лежат установки игроков.
const ROOT = path.join(app.getPath('appData'), '.minecraft_pvl');

// Откуда брать config.json (новости, сплэши, сервер, ссылки на сборки)
const CONFIG_SOURCES = [
    'https://raw.githubusercontent.com/witchcorepvl-coder/pvl-launcher-data/main/config.json',
    'https://cdn.jsdelivr.net/gh/witchcorepvl-coder/pvl-launcher-data@main/config.json'
];

const DEFAULT_SERVER = 'anfisa.proximamp.com:27292';

// Сборки. gameDir: папка с модами/настройками/мирами (null = корень .minecraft_pvl).
// libraries / assets / versions общие для всех сборок.
const BUILDS = {
    full: {
        id: 'full', name: 'FULL',
        url: 'https://www.dropbox.com/scl/fi/cuboqntizj8a8xcivweuf/lite.zip?rlkey=1raqfkwwir8latx742b8r5zla&dl=1',
        gameDir: null,
        versionId: 'neoforge-21.1.264',
        ramMB: 6144
    },
    lite: {
        id: 'lite', name: 'LITE',
        url: 'https://www.dropbox.com/scl/fi/9e6gs31k22uxk6vd2xfpn/lite.zip?rlkey=rg1pnokuik41r066h54loilcr&dl=1',
        gameDir: 'builds/lite',
        versionId: 'neoforge-21.1.264',
        ramMB: 4096
    }
};

module.exports = {
    IS_WIN, IS_MAC, OS_NAME, ROOT, CONFIG_SOURCES, DEFAULT_SERVER, BUILDS,
    SHARED_DIRS: ['libraries', 'assets', 'versions'],
    BUILD_MARKER: '.pvl_build.json',
    VANILLA_ID: '1.21.1',
    MIN_JAVA: 21,
    UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PVLCraftLauncher/2.0',
    MOJANG_MANIFEST: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    MOJANG_RESOURCES: 'https://resources.download.minecraft.net',
    // Дополнительные флаги Java для модов сборки
    EXTRA_JVM_ARGS: [
        '-Dcustomskinloader.ignorePatchFailure=true',
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'
    ]
};
