/* 当日天气 → 背景形态（只影响背景，不显示任何天气数据）
   晴天：洁白云 + 湛蓝天空；阴天：灰白金属光泽玻璃云；雨天：云收起 + 淡蓝雨丝；雪天：玻璃雪花
   取数走定位 + 天气码两次公开请求，每天只查一次，结果写进 settings 缓存；
   失败、离线、被拒绝都静默回落到上一次的形态，最差是晴天。首屏不等网络。 */

(function () {
  const KINDS = ['sunny', 'cloudy', 'rain', 'snow'];
  let cur = 'sunny';
  let enabled = true;
  let refreshing = false;
  let place = '';          /* 最近一次定位到的城市名，只给设置页展示用 */

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

  /* v2.39 定位修复：以前按 IP 定位（wttr.in 也是按 IP），走代理时出口 IP 会落在境外，
     东京下雨就把本地背景画成雨。现在先看「IP 时区」与「浏览器时区」对不对得上，
     对不上就判定 IP 不可信，退回到浏览器时区对应的代表城市；用户在设置里填了城市则最优先。 */
  const TZ_CITY = {
    'Asia/Shanghai': [31.23, 121.47, '上海'],
    'Asia/Chongqing': [29.56, 106.55, '重庆'],
    'Asia/Urumqi': [43.83, 87.62, '乌鲁木齐'],
    'Asia/Harbin': [45.80, 126.53, '哈尔滨'],
    'Asia/Hong_Kong': [22.32, 114.17, '香港'],
    'Asia/Macau': [22.20, 113.55, '澳门'],
    'Asia/Taipei': [25.03, 121.57, '台北'],
    'Asia/Tokyo': [35.69, 139.69, '东京'],
    'Asia/Seoul': [37.57, 126.98, '首尔'],
    'Asia/Singapore': [1.35, 103.82, '新加坡'],
    'Asia/Bangkok': [13.76, 100.50, '曼谷'],
    'Europe/London': [51.51, -0.13, '伦敦'],
    'Europe/Paris': [48.86, 2.35, '巴黎'],
    'Europe/Berlin': [52.52, 13.40, '柏林'],
    'America/New_York': [40.71, -74.01, '纽约'],
    'America/Chicago': [41.88, -87.63, '芝加哥'],
    'America/Los_Angeles': [34.05, -118.24, '洛杉矶'],
    'Australia/Sydney': [-33.87, 151.21, '悉尼']
  };

  function tzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  function setPlace(name) {
    if (!name) return;
    place = name;
    try { document.documentElement.setAttribute('data-weather-place', name); } catch (e) { /* 忽略 */ }
  }

  /* 定位被判为不可信时提示一次：国内全境同一个时区，兜底只能给代表城市，
     真正准的城市得用户自己填，所以这里说清入口。 */
  async function warnProxyOnce(cityName) {
    try {
      if (await DB.getSetting('weatherProxyWarned', false)) return;
      await DB.setSetting('weatherProxyWarned', true);
      if (window.UI && UI.toast) {
        UI.toast('定位疑似走代理，天气先按' + cityName + '显示，设置里可改城市');
      }
    } catch (e) { /* 提示失败不影响天气 */ }
  }

  /* 返回 { lat, lon } 或 null；顺带把地名写进 place */
  async function locate() {
    let manual = null;
    try { manual = await DB.getSetting('weatherCity', null); } catch (e) { manual = null; }
    if (manual && isFinite(Number(manual.lat)) && isFinite(Number(manual.lon))) {
      setPlace(manual.name || '已指定城市');
      return { lat: Number(manual.lat), lon: Number(manual.lon) };
    }

    const tz = tzName();
    const geo = await fetchJson('https://get.geojs.io/v1/ip/geo.json', 6000);
    const lat = geo ? Number(geo.latitude) : NaN;
    const lon = geo ? Number(geo.longitude) : NaN;
    const ipOk = isFinite(lat) && isFinite(lon);
    const sameTz = !!(geo && geo.timezone && tz && geo.timezone === tz);

    if (ipOk && sameTz) {
      setPlace(geo.city || geo.region || '');
      return { lat: lat, lon: lon };
    }
    const fb = TZ_CITY[tz];
    if (fb) {
      setPlace(fb[2]);
      await warnProxyOnce(fb[2]);
      return { lat: fb[0], lon: fb[1] };
    }
    if (ipOk) {
      setPlace(geo.city || geo.region || '');
      return { lat: lat, lon: lon };
    }
    return null;
  }

  async function fetchKind() {
    const pos = await locate();
    if (!pos) return '';
    const met = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' +
      pos.lat.toFixed(2) + '&longitude=' + pos.lon.toFixed(2) + '&current=weather_code', 6000);
    if (!met || !met.current) return '';
    return kindOf(met.current.weather_code);
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
      const got = await fetchKind();
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

  /* 手动改了城市后立刻重查，不受当天缓存与六小时退避限制 */
  async function forceRefresh() {
    refreshing = false;
    try { await DB.setSetting('weatherTryAt', 0); } catch (e) { /* 忽略 */ }
    try { await DB.setSetting('weatherDay', ''); } catch (e) { /* 忽略 */ }
    await refresh('');
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
    forceRefresh: forceRefresh,
    city: function () { return place; },
    kindOf: kindOf,
    label: { sunny: '晴', cloudy: '阴', rain: '雨', snow: '雪' }
  };
})();
