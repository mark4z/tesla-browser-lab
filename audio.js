'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const playerProbe = document.createElement('audio');
  const formats = [
    ['WAV PCM', 'audio/wav; codecs="1"'],
    ['FLAC 文件', 'audio/flac'],
    ['FLAC / MP4', 'audio/mp4; codecs="flac"'],
    ['AAC / MP4', 'audio/mp4; codecs="mp4a.40.2"'],
    ['Opus / WebM', 'audio/webm; codecs="opus"']
  ];
  const claims = formats.map(([name, mime]) => {
    let mse = 'API 不可用';
    try { if (window.MediaSource && MediaSource.isTypeSupported) mse = MediaSource.isTypeSupported(mime) ? '声明支持' : '未声明支持'; } catch (_) { mse = '查询失败'; }
    return {name, mime, audio: playerProbe.canPlayType(mime) || '未声明支持', mse};
  });
  byId('audioClaims').textContent = claims.map(c => c.name + '\n  audio: ' + c.audio + '；MSE: ' + c.mse).join('\n');
  let current = null;
  const history = [];
  const round = n => Number.isFinite(n) ? +n.toFixed(3) : null;
  function refresh() { if (typeof report === 'function') report(); }
  function renderRecord(r) {
    byId('audioActual').textContent = '本次：' + r.sample + '；playing=' + r.playing + '；时间=' + r.mediaSeconds + ' 秒；waiting=' + r.waiting + '；stalled=' + r.stalled + '；听感需手动确认';
  }
  function syncButtons() {
    byId('audioChannels').disabled = byId('audioSteady').disabled = !byId('parked').checked;
    byId('audioStop').disabled = !current;
  }
  window.audioReport = () => ({sampleRate:48000, channels:2, elementVolume:0.25, claims, mseAppendTested:false, routingVerified:false, latencyMeasured:false, runs:history});
  function stopAudio(reason) { if (current) current.finish(reason || '手动停止'); }
  window.stopAudioTest = stopAudio;
  function start(kind) {
    if (!byId('parked').checked || document.hidden) return;
    stopAudio('被新测试替代');
    if (typeof running !== 'undefined' && running) stop();
    byId('video').pause();
    const previous = byId('audio');
    const audio = document.createElement('audio');
    audio.id = 'audio'; audio.preload = 'none'; audio.volume = .25; audio.loop = false;
    audio.setAttribute('aria-label', '手动触发的音频测试');
    previous.replaceWith(audio);
    const r = {sample:kind === 'channels' ? 'WAV 3s left-right-both' : 'FLAC 12s continuous', status:'请求播放', playPromise:'pending', playing:0, waiting:0, stalled:0, timeUpdates:0, mediaSeconds:0, durationSeconds:null, elapsedSeconds:0, mediaErrorCode:null, heard:'unconfirmed'};
    history.push(r); if (history.length > 10) history.shift();
    byId('audioHeard').disabled = false; byId('audioHeard').value = 'unconfirmed';
    const started = performance.now();
    let done = false;
    const listeners = [];
    function on(type, fn) { audio.addEventListener(type, fn); listeners.push([type, fn]); }
    function snapshot() { r.mediaSeconds = round(audio.currentTime); r.durationSeconds = round(audio.duration); r.elapsedSeconds = round((performance.now() - started) / 1000); }
    function finish(reason) {
      if (done) return;
      done = true; clearTimeout(timer); snapshot(); r.status = reason;
      listeners.forEach(([type, fn]) => audio.removeEventListener(type, fn));
      audio.pause(); audio.removeAttribute('src'); audio.load();
      current = null;
      byId('audioStatus').textContent = reason + '；请确认刚才是否听到声音';
      renderRecord(r); syncButtons(); refresh();
    }
    const timer = setTimeout(() => finish('达到 20 秒安全上限 / 未完成'), 20000);
    current = {finish, r};
    on('playing', () => { r.playing++; r.status='正在播放'; byId('audioStatus').textContent='浏览器正在播放；是否有声音请实际听一下'; snapshot(); renderRecord(r); refresh(); });
    for (const type of ['waiting', 'stalled']) on(type, () => { r[type]++; snapshot(); renderRecord(r); refresh(); });
    on('loadedmetadata', () => { snapshot(); refresh(); });
    on('timeupdate', () => { r.timeUpdates++; snapshot(); renderRecord(r); refresh(); });
    on('ended', () => finish('文件播放结束'));
    on('error', () => { r.mediaErrorCode = audio.error ? audio.error.code : null; finish('文件播放失败'); });
    audio.src = kind === 'channels' ? 'assets/audio-channels-48k.wav' : 'assets/audio-steady-48k.flac';
    byId('audioStatus').textContent='请求播放…'; renderRecord(r); syncButtons(); refresh();
    try {
      const promise = audio.play();
      if (promise && promise.then) promise.then(() => { if (!done) { r.playPromise='resolved'; refresh(); } }).catch(e => { if (!done) { r.playPromise='rejected: '+(e && e.name ? e.name : 'Error'); finish('无法开始播放'); } });
      else r.playPromise='浏览器未返回 Promise';
    } catch (e) { r.playPromise='threw: '+(e && e.name ? e.name : 'Error'); finish('无法开始播放'); }
  }
  byId('audioChannels').onclick = () => start('channels');
  byId('audioSteady').onclick = () => start('steady');
  byId('audioStop').onclick = () => stopAudio('手动停止');
  byId('audioHeard').onchange = () => { if (history.length) { history[history.length-1].heard=byId('audioHeard').value; refresh(); } };
  byId('parked').addEventListener('change', () => { if (!byId('parked').checked) stopAudio('已取消停车确认'); syncButtons(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio('页面进入后台，已停止'); });
  window.addEventListener('pagehide', () => stopAudio('已离开页面'));
  byId('video').addEventListener('play', () => stopAudio('视频播放开始，已停止声音'));
  syncButtons(); refresh();
})();
