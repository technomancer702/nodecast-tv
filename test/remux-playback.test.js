const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('probe preserves every audio track index including unknown codecs', () => {
    const filename = path.join(__dirname, '..', 'server/routes/probe.js');
    const context = vm.createContext({ require: createRequire(filename), module: { exports: {} }, console });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const info = context.analyzeProbeResult({ streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'mp3' },
        { codec_type: 'subtitle', codec_name: 'srt' },
        { codec_type: 'audio' }, { codec_type: 'audio', codec_name: 'AAC' }
    ], format: { format_name: 'mpegts' } }, 'http://provider.test/media.ts');
    assert.deepEqual(Array.from(info.audioCodecs), ['mp3', 'unknown', 'aac']);
    assert.equal(info.needsRemux, true);
});

function playerFixture(name, settings, probe, navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 }) {
    const window = { dispatchEvent() {} };
    const context = { window, navigator, HlsAudioRecovery: require('../public/js/components/HlsAudioRecovery'), PlaybackProbe: require('../public/js/components/PlaybackProbe'), CaptionTracks: require('../public/js/components/CaptionTracks'), VodDuration: require('../public/js/components/VodDuration'), console: { log() {}, warn() {}, error() {} },
        CustomEvent: class {}, document: { getElementById() { return null; } },
        API: { settings: { get: async () => settings } }, fetch: probe };
    const file = name === 'VideoPlayer' ? 'components/VideoPlayer.js' : 'pages/WatchPage.js';
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public/js', file), 'utf8'), context);
    const player = Object.create(window[name].prototype);
    const element = { classList: { add() {}, remove() {} } };
    Object.assign(player, { settings, video: { src: '', play: async () => {}, querySelectorAll: () => [] },
        overlay: element, nowPlaying: element,
        sessions: [],
        async startTranscodeSession(url, options) { this.sessions.push({ url, options }); return '/api/session/stream.m3u8'; },
        playHls(url) { this.video.src = url; },
        stop() { this.playbackGeneration = (this.playbackGeneration || 0) + 1; this.video.src = ''; },
        updateTranscodeStatus() {}, updateQualityBadge() {}, updateNowPlaying() {},
        showNowPlayingOverlay() {}, fetchEpgData() {}, setVolumeFromStorage() {}, showLoading() {},
        showError(message) { throw new Error(message); }
    });
    player.start = url => name === 'VideoPlayer' ? player.play({ id: url }, url) : player.loadVideo(url);
    player.fixtureContext = context; return player;
}

for (const [device, navigator] of [
    ['iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 }],
    ['iPad', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }]
]) {
    for (const mode of ['autoTranscode', 'forceRemux']) {
        test(`VideoPlayer ${mode} uses a copy HLS session for remux on ${device}`, async () => {
            const player = playerFixture('VideoPlayer', { [mode]: true }, async () => ({
                json: async () => ({ video: 'h264', audio: 'aac', audioCodecs: ['aac'], needsRemux: true })
            }), navigator);
            const url = 'http://provider.test/live/1.ts';
            await player.start(url);
            assert.equal(player.sessions.length, 1);
            assert.equal(player.sessions[0].url, url);
            assert.equal(player.sessions[0].options.videoMode, 'copy');
            assert.equal(player.sessions[0].options.videoCodec, 'h264');
            assert.equal(player.video.src, '/api/session/stream.m3u8');
        });
    }
}

for (const name of ['VideoPlayer', 'WatchPage']) {
    for (const mode of ['autoTranscode', 'forceRemux']) {
        test(`${name} ${mode} preserves probe metadata when choosing remux playback`, async () => {
            const requests = [];
            const player = playerFixture(name, { [mode]: true }, async url => {
                requests.push(url);
                return { json: async () => ({ audio: 'mp3', audioCodecs: ['mp3', 'aac'], needsRemux: true }) };
            });
            const url = 'http://provider.test/media.ts?password=abc/';
            await player.start(url);
            if (name === 'WatchPage') {
                assert.equal(player.sessions.length, 1);
                assert.equal(player.sessions[0].url, url);
                assert.equal(player.sessions[0].options.videoMode, 'copy');
                assert.equal(player.sessions[0].options.audioCodec, 'mp3');
                assert.equal(player.video.src, '/api/session/stream.m3u8');
                assert.equal(requests.length, 1);
                return;
            }
            const remux = new URL(player.video.src, 'http://app.test');
            assert.equal(remux.pathname, '/api/remux');
            assert.equal(remux.searchParams.get('url'), url);
            assert.equal(remux.searchParams.get('audioCodecs'), 'mp3,aac');
            assert.equal(requests.length, 1);
        });
    }
    test(`${name} ignores a remux probe that completes after playback stops`, async () => {
        let complete, started;
        const probing = new Promise(resolve => { started = resolve; });
        const player = playerFixture(name, { forceRemux: true }, () => {
            started();
            return new Promise(resolve => { complete = resolve; });
        });
        const playing = player.start('http://provider.test/media.ts');
        await probing;
        player.stop();
        complete({ json: async () => ({ audioCodecs: ['aac'] }) });
        await playing;
        assert.equal(player.video.src, '');
    });
    test(`${name} ignores a failed automatic probe after playback stops`, async () => {
        let fail, started;
        const probing = new Promise(resolve => { started = resolve; });
        const player = playerFixture(name, { autoTranscode: true }, () => {
            started();
            return new Promise((resolve, reject) => { fail = reject; });
        });
        const playing = player.start('http://provider.test/movie.mp4');
        await probing;
        player.stop();
        fail(new Error('Provider unavailable'));
        await playing;
        assert.equal(player.video.src, '');
    });
}

for (const mode of ['autoTranscode', 'forceRemux']) {
 test('iOS native-only HLS starts the remux session in ' + mode, async () => {
  const player=playerFixture('VideoPlayer',{[mode]:true},async()=>({json:async()=>({video:'h264',audio:'aac',needsRemux:true})}),{userAgent:'iPhone',maxTouchPoints:5});
  player.fixtureContext.Hls=class { static isSupported(){return false;} constructor(){throw Error('Unsupported MSE must not be constructed');} };
  player.video.canPlayType=()=> 'probably';
  player.playHls=player.fixtureContext.window.VideoPlayer.prototype.playHls;
  await player.start('http://provider/live.ts');
  assert.equal(player.video.src,'/api/session/stream.m3u8'); assert.equal(player.hls,null);
  assert.equal(player.sessions.length,1);
 });
}
