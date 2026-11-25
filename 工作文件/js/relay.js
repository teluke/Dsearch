/*
 * 局域网中转站（v2.11）——只负责「牵线」，不搬文件
 * ---------------------------------------------------------------
 * 为什么要有这条通道
 *   WebRTC 直连本来就要靠 SDP 手递手配对：电脑生成二维码、平板扫、平板再回一段
 *   返回码、电脑再粘回去。平板网卡一多配对码就炸，任何一步错了两端还各说各话。
 *   这里把「递 SDP」这件事交给本机服务：平板打开一个网址，配对信息自动交换，
 *   连上之后一切交给原来的传输管线（分片、勾选、对账、实时推送全都复用）。
 *
 * 安全边界（老实说明）
 *   1. 只走本机与私网：服务端只接受私网来源，校验 Host/Origin 挡 DNS rebinding 与跨站。
 *   2. 中转服务只转发两段 SDP 文本，不接触文件内容，不写磁盘，会话闲置 10 分钟即销毁。
 *   3. 文件本身走 WebRTC 数据通道，DTLS 端到端加密——和手机同步用的同一套强度。
 *   4. 如果有人能在同一网段做中间人，理论上可以替换 SDP。真要防这一层，
 *      用「生成配对码 → 扫码」那条离线交换的路（面板里仍然保留）。
 */

(function () {
  'use strict';

  const POLL_STATUS = 1200;
  const POLL_SIG = 800;

  const S = {
    phase: 'idle',      // idle | wait | connecting | done | error
    role: '',           // 'desk' | 'client'
    sid: '', code: '', token: '', url: '',
    message: '', lastError: '',
    connected: false,
    available: null     // null=还没探过，true/false=本机服务在不在
  };

  let statusTimer = null;
  let sigTimer = null;
  let handlers = {};
  let offering = false;

  /* ---------------- 事件 ---------------- */

  function on(name, fn) {
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(fn);
  }

  function emit(name, data) {
    (handlers[name] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { /* 单个监听器出错不影响其它 */ }
    });
  }

  function state() {
    return {
      phase: S.phase, role: S.role, sid: S.sid, code: S.code, url: S.url,
      message: S.message, lastError: S.lastError, connected: S.connected
    };
  }

  function setPhase(p, msg) {
    S.phase = p;
    if (msg != null) S.message = msg;
    emit('state', state());
  }

  /* 本机服务在不在：GitHub Pages 这类纯静态部署上没有 /api/relay，
     按钮点了只会报错，不如提前探一次把入口藏起来 */
  function probe() {
    if (S.available !== null) return Promise.resolve(S.available);
    return fetch(apiUrl('addr'), { cache: 'no-store', credentials: 'omit' })
      .then(function (r) {
        const type = r.headers.get('content-type') || '';
        S.available = r.ok && type.indexOf('json') >= 0;
        return S.available;
      })
      .catch(function () { S.available = false; return false; })
      .then(function (v) { emit('ready', { available: v }); return v; });
  }

  function available() { return S.available; }

  function supported() {
    return !!(window.Sync && window.Sync.isSupported && window.Sync.isSupported() && window.fetch);
  }

  /* ---------------- 接口 ---------------- */

  function apiUrl(name) {
    const base = location.pathname.replace(/[^/]*$/, '');
    return base + 'api/relay/' + name;
  }

  async function api(name, opts) {
    opts = opts || {};
    const headers = {};
    if (S.token) headers['X-Relay-Token'] = S.token;
    let body;
    if (opts.json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(apiUrl(name), {
      method: opts.method || (body ? 'POST' : 'GET'),
      headers: headers,
      body: body,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    });
    const type = res.headers.get('content-type') || '';
    if (type.indexOf('json') < 0) {
      /* 静态服务接走了这个请求：说明没跑 server.js（比如 GitHub Pages） */
      throw new Error('这台电脑没有运行本机服务，中转用不了');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('服务返回 ' + res.status));
    return data;
  }

  /* 电脑端一般是 localhost 打开的，二维码里必须换成平板能访问的内网地址 */
  async function lanOrigin() {
    const host = location.hostname;
    const isLoop = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!isLoop) return location.origin;
    try {
      const r = await api('addr', {});
      const list = (r.addrs || []).filter(Boolean);
      if (list.length) return 'http://' + list[0] + ':' + (r.port || location.port || 80);
    } catch (e) { /* 拿不到就退回当前地址 */ }
    return location.origin;
  }

  function stopTimers() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (sigTimer) { clearTimeout(sigTimer); sigTimer = null; }
  }

  function reset() {
    stopTimers();
    S.phase = 'idle'; S.role = ''; S.sid = ''; S.code = ''; S.token = ''; S.url = '';
    S.message = ''; S.lastError = ''; S.connected = false;
    offering = false;
  }

  /* ---------------- 电脑端 ---------------- */

  async function openDesk() {
    if (!supported()) throw new Error('当前浏览器不支持局域网直连，请用 Chrome / Edge / Safari');
    reset();
    S.role = 'desk';
    /* 先挂在 opening 上，等网址算好再进 wait，否则界面会先亮出一个空二维码 */
    setPhase('opening', '正在准备…');
    let r;
    try {
      r = await api('open', { json: {} });
    } catch (e) {
      S.lastError = e.message || '开启失败';
      setPhase('error', S.lastError);
      throw e;
    }
    S.sid = r.sid; S.code = r.code; S.token = r.token;
    /* 二维码里只有网址和一次性会话号：几十个字符，不会密到扫不出 */
    const host = await lanOrigin();
    S.url = host + location.pathname + '#relay=' + r.sid + '.' + r.code;
    setPhase('wait', '等平板扫码');
    startStatusPoll();
    return state();
  }

  function startStatusPoll() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(checkStatus, POLL_STATUS);
    checkStatus();
  }

  async function checkStatus() {
    if (!S.sid || !S.token) return;
    let r;
    try {
      r = await api('status?sid=' + encodeURIComponent(S.sid), {});
    } catch (e) {
      return;
    }
    if (!r.joined || offering) return;
    offering = true;
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    startOffer();
  }

  /* 平板进来了：生成一次 offer 放进会话，然后等它回 answer */
  async function startOffer() {
    setPhase('connecting', '正在建立直连…');
    let sdp;
    try {
      sdp = await window.Sync.createOffer();
    } catch (e) {
      S.lastError = (e && e.message) || '生成配对信息失败';
      setPhase('error', S.lastError);
      return;
    }
    try {
      await api('sig?kind=offer', { method: 'POST', json: { sdp: sdp } });
    } catch (e) {
      S.lastError = (e && e.message) || '配对信息没送到';
      setPhase('error', S.lastError);
      return;
    }
    waitAnswer();
  }

  async function waitAnswer() {
    if (sigTimer) clearTimeout(sigTimer);
    sigTimer = setTimeout(async function () {
      if (S.phase === 'done') return;
      let r;
      try {
        r = await api('sig?kind=answer', {});
      } catch (e) {
        if (isGone(e)) return gone(e);
        r = null;
      }
      if (r && r.sdp) {
        try {
          await window.Sync.acceptAnswer(r.sdp);
          /* 剩下的交给原管线：sync-ui 收到 connected 会自动开始推送 */
          setPhase('done', '已连接');
        } catch (e) {
          S.lastError = (e && e.message) || '配对信息无效';
          setPhase('error', S.lastError);
        }
        return;
      }
      waitAnswer();
    }, POLL_SIG);
  }

  /* ---------------- 平板端 ---------------- */

  function parseHash(hash) {
    const h = String(hash || location.hash || '');
    const m = /relay=([0-9a-f]{6,32})\.(\d{6})/.exec(h);
    if (!m) return null;
    return { sid: m[1], code: m[2] };
  }

  async function join(sid, code) {
    if (!supported()) throw new Error('当前浏览器不支持局域网直连，请用 Chrome / Edge / Safari');
    reset();
    S.role = 'client';
    S.sid = sid;
    setPhase('connecting', '正在连接电脑…');
    let r;
    try {
      r = await api('join', { json: { sid: sid, code: code } });
    } catch (e) {
      S.lastError = e.message || '连接失败';
      setPhase('error', S.lastError);
      throw e;
    }
    S.token = r.token;
    waitOffer();
    return state();
  }

  async function waitOffer() {
    if (sigTimer) clearTimeout(sigTimer);
    sigTimer = setTimeout(async function () {
      if (S.phase === 'done') return;
      let r;
      try {
        r = await api('sig?kind=offer', {});
      } catch (e) {
        if (isGone(e)) return gone(e);
        r = null;
      }
      if (r && r.sdp) {
        let ans;
        try {
          ans = await window.Sync.acceptOffer(r.sdp);
        } catch (e) {
          S.lastError = (e && e.message) || '收到的是无效的配对信息';
          setPhase('error', S.lastError);
          return;
        }
        try {
          await api('sig?kind=answer', { method: 'POST', json: { sdp: ans } });
        } catch (e) {
          if (isGone(e)) return gone(e);
          S.lastError = (e && e.message) || '返回信息没送到电脑';
          setPhase('error', S.lastError);
          return;
        }
        setPhase('done', '已连接，等待电脑推送');
        return;
      }
      waitOffer();
    }, POLL_SIG);
  }

  /* ---------------- 收尾 ---------------- */

  function isGone(e) {
    const m = (e && e.message) || '';
    return m.indexOf('会话') >= 0 || m.indexOf('404') >= 0;
  }

  function gone(e) {
    stopTimers();
    S.lastError = (e && e.message) || '会话已结束';
    setPhase('error', S.lastError);
  }

  async function disconnect() {
    const role = S.role;
    const token = S.token;
    const sid = S.sid;
    stopTimers();
    S.token = token;
    try {
      if (role === 'desk' && token) await api('close?sid=' + encodeURIComponent(sid), { method: 'POST' });
      else if (role === 'client' && token) await api('leave', { method: 'POST' });
    } catch (e) { /* 已经过期了也没关系 */ }
    reset();
    setPhase('idle', '');
  }

  /* 地址里带 #relay=… 就是扫了电脑的网址：等界面就绪后自己把同步面板打开。
     放在这里而不是 app.js，是为了不依赖两者的加载顺序 */
  probe();

  if (parseHash()) {
    let tries = 0;
    const timer = setInterval(function () {
      tries++;
      if (window.SyncUI) {
        clearInterval(timer);
        window.SyncUI.open();
      } else if (tries > 60) {
        clearInterval(timer);
      }
    }, 150);
  }

  window.Relay = {
    supported: supported,
    available: available,
    probe: probe,
    open: openDesk,
    join: join,
    parseHash: parseHash,
    disconnect: disconnect,
    state: state,
    on: on
  };
})();
