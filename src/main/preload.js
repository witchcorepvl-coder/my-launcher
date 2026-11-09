// Мост между интерфейсом и главным процессом: только нужные функции, без доступа к Node.js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
    const fn = (_, ...a) => cb(...a);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('pvl', {
    init: () => ipcRenderer.invoke('app:init'),
    refreshConfig: () => ipcRenderer.invoke('config:refresh'),
    buildsState: () => ipcRenderer.invoke('builds:state'),
    serverStatus: () => ipcRenderer.invoke('server:status'),
    lookupSkin: (nick) => ipcRenderer.invoke('skin:lookup', nick),
    play: (opts) => ipcRenderer.invoke('game:play', opts),
    onLog: on('game:log'),
    onStatus: on('game:status'),
    onProgress: on('game:progress'),
    onStage: on('game:stage'),
    onStarted: on('game:started'),
    openFolder: (build) => ipcRenderer.send('folder:open', build),
    copy: (text) => ipcRenderer.send('clipboard:write', text),
    openLink: (url) => ipcRenderer.send('link:open', url),
    minimize: () => ipcRenderer.send('win:minimize'),
    close: () => ipcRenderer.send('win:close'),
    log: (level, text) => ipcRenderer.send('renderer:log', String(level), String(text))
});
