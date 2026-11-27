/* 当日天气 → 背景形态（只影响背景，不显示任何天气数据）
   晴天：洁白云 + 湛蓝天空；阴天：灰白金属光泽玻璃云；雨天：云收起 + 淡蓝雨丝；雪天：玻璃雪花
   取数走两次公开接口（IP 定位 + 天气码），每天只请求一次，结果写进 settings 缓存；
   失败、离线、被拒绝都静默回落到上一次的形态，最差是晴天。首屏不等网络。 */

(function () {
  const KINDS = ['sunny', 'cloudy', 'rain', 'snow'];
  let cur = 'sunny';
  let enabled = true;
  let refreshing = false;

  /* WMO weather code → 四种形态 */
  function kindOf(code) {
    const c = Number(code);
    if (code == null || isNaN(c)) return 'sunny';
    if (c === 0 || c === 1) return 'sunny';
    if (c === 2 || c === 3 || c === 45 || c === 48) return 'cloudy';
    if (c >= 51 && c <= 67) return 'rain';
    if (c >= 71 && c <= 77) return 'snow';
    if (c >= 80 && c <= 82) return 'rain';
    if (c === 85 || c === 86) return 'snow';
    if (c >= 95) return 'rain';
    return 'cloudy';
  }

  function apply(kind) {
    cur = KINDS.indexOf(kind) >= 0 ? kind : 'sunny';
    document.documentElement.setAttribute('data-weather', cur);
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  async function readCache() {
    let out = { day: '', kind: '' };
    try {
      out.day = (await DB.getSetting('weatherDay', '')) || '';
      out.kind = (await DB.getSetting('weatherKind', '')) || '';
    } catch (e) { /* 设置读不到就当没缓存 */ }
    return out;
  }

  async function fetchJson(url, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 6000) : 0;
    try {
      const res = await fetch(url, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* 两家公开源并行请求，谁先给结果用谁：
     wttr.in 按 IP 直接给天气码（国内可达），open-meteo 走定位（海外更快）。都不需要 key。
     任一失败就忽略，两路都空则保持原形态。 */
  const WWO_SNOW = [179, 182, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377, 392, 395];
  const WWO_RAIN = [176, 185, 200, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359, 386, 389];

  function kindOfWwo(code) {
    const c = Number(code);
    if (!isFinite(c)) return '';
    if (c === 113 || c === 116) return 'sunny';
    if (WWO_SNOW.indexOf(c) >= 0) return 'snow';
    if (WWO_RAIN.indexOf(c) >= 0) return 'rain';
    if (c === 119 || c === 122 || c === 143 || c === 248 || c === 260) return 'cloudy';
    return '';
  }

  async function fromWttr() {
    const d = await fetchJson('https://wttr.in/?format=j1', 9000);
    if (!d || !d.current_condition || !d.current_condition[0]) return '';
    return kindOfWwo(d.current_condition[0].weatherCode);
  }

  async function fromOpenMeteo() {
    const geo = await fetchJson('https://get.geojs.io/v1/ip/geo.json', 6000);
    const lat = geo ? Number(geo.latitude) : NaN;
    const lon = geo ? Number(geo.longitude) : NaN;
    if (!isFinite(lat) || !isFinite(lon)) return '';
    const met = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' +
      lat.toFixed(2) + '&longitude=' + lon.toFixed(2) + '&current=weather_code', 6000);
    if (!met || !met.current) return '';
    return kindOf(met.current.weather_code);
  }

  /* 谁先回非空结果就用谁，另一路不等 */
  function lookup() {
    return new Promise(function (resolve) {
      let left = 2, done = false;
      [fromWttr, fromOpenMeteo].forEach(function (fn) {
        Promise.resolve().then(fn).then(function (k) {
          if (k && !done) { done = true; resolve(k); return; }
        }).catch(function () { /* 忽略 */ }).then(function () {
          left--;
          if (left === 0 && !done) { done = true; resolve(''); }
        });
      });
    });
  }

  /* 后台补一次：拿到新形态就写缓存并换背景；拿不到保持原样 */
  async function refresh(cached) {
    if (refreshing) return;
    /* 六小时内试过且没结果就跳过，避免反复请求把接口打成 429 */
    let lastTry = 0;
    try { lastTry = (await DB.getSetting('weatherTryAt', 0)) || 0; } catch (e) { lastTry = 0; }
    if (!cached && Date.now() - lastTry < 6 * 3600 * 1000) return;
    refreshing = true;
    try {
      try { await DB.setSetting('weatherTryAt', Date.now()); } catch (e) { /* 忽略 */ }
      const got = await lookup();
      if (!got) return;
      if (got !== cached) {
        if (enabled) apply(got);
      }
      try {
        await DB.setSettings({ weatherDay: today(), weatherKind: got });
      } catch (e) { /* 写不进缓存不影响本次显示 */ }
    } finally {
      refreshing = false;
    }
  }

  async function init() {
    let on = true;
    try { on = (await DB.getSetting('weatherBg', true)) !== false; } catch (e) { on = true; }
    enabled = on;
    if (!enabled) { apply('sunny'); return; }

    const cache = await readCache();
    const fresh = cache.day === today() && KINDS.indexOf(cache.kind) >= 0;
    /* 先用缓存或上一次的形态铺上，不等网络 */
    apply(fresh ? cache.kind : (KINDS.indexOf(cache.kind) >= 0 ? cache.kind : 'sunny'));
    if (!fresh) refresh(cache.kind);
  }

  async function setEnabled(on) {
    enabled = on !== false;
    try { await DB.setSetting('weatherBg', enabled); } catch (e) { /* 忽略 */ }
    if (!enabled) { apply('sunny'); return; }
    const cache = await readCache();
    const fresh = cache.day === today() && KINDS.indexOf(cache.kind) >= 0;
    apply(fresh ? cache.kind : 'sunny');
    if (!fresh) refresh(cache.kind);
  }

  window.Weather = {
    init: init,
    get: function () { return cur; },
    enabled: function () { return enabled; },
    setEnabled: setEnabled,
    kindOf: kindOf,
    label: { sunny: '晴', cloudy: '阴', rain: '雨', snow: '雪' }
  };
})();
