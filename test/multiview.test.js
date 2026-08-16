const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadMultiViewPage(documentOverrides = {}) {
    const grid = {
        innerHTML: '',
        addEventListener() {},
        querySelector() { return null; },
        classList: { add() {}, remove() {} }
    };
    const document = {
        fullscreenElement: null,
        webkitFullscreenElement: null,
        getElementById(id) { return id === 'multiview-grid' ? grid : null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        ...documentOverrides
    };
    const context = {
        console,
        document,
        localStorage: { getItem() { return null; }, setItem() {} },
        window: {}
    };
    vm.runInNewContext(fs.readFileSync('public/js/pages/MultiViewPage.js', 'utf8'), context);
    return { MultiViewPage: context.window.MultiViewPage, document, grid };
}

test('multi-view renders and activates the exit-fullscreen control', () => {
    let exitCalls = 0;
    const { MultiViewPage, document, grid } = loadMultiViewPage({
        fullscreenElement: {},
        exitFullscreen() { exitCalls += 1; }
    });
    const page = new MultiViewPage({});

    assert.match(grid.innerHTML, /data-action="exit-fullscreen"/);
    assert.match(grid.innerHTML, /Sair da tela cheia/);
    page.exitFullscreen();
    assert.equal(exitCalls, 1);
    assert.ok(document.fullscreenElement);
});
