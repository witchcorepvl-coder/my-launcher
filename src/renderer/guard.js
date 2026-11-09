// Страж запуска: грузится первым. Если какой-то скрипт интерфейса упал и окно не «ожило» за 3 секунды —
// показываем текст ошибки на экране и пишем его в logs/launcher.log (вместо пустого окна).
'use strict';
(() => {
    const errors = [];
    const send = (t) => { try { window.pvl && window.pvl.log('error', t); } catch {} };
    window.addEventListener('error', (e) => {
        // ошибки загрузки файлов (картинка, скрипт) приходят с target, а не с message
        const t = e.message
            ? `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno || 0}`
            : `не загрузился файл: ${(e.target && (e.target.src || e.target.href)) || '?'}`;
        errors.push(t); send('[guard] ' + t);
    }, true);
    setTimeout(() => {
        if (document.body.classList.contains('ready')) return;
        const box = document.getElementById('fatal');
        const text = errors.length ? errors.join('\n') : 'Интерфейс не запустился, но ошибок не поймано.';
        send('[guard] окно не запустилось за 3 с:\n' + text);
        if (box) { document.getElementById('fatalText').textContent = text; box.classList.remove('hidden'); }
    }, 3000);
})();
