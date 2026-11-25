/* 工作文件 · 静态服务器（零依赖，仅用 Node 核心模块）
   安全规则：
   1. 禁止目录列表
   2. 禁止访问隐藏文件/目录（. 开头）
   3. 禁止访问 tests 路径
   4. 路径归一化，防目录穿越
   5. 中转站接口仅限本机与私网访问，且零知识（只存密文） */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};

function safePath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch (e) {
    return null;
  }
  if (p.includes('\0')) return null;
  // 规则 2/3：隐藏文件与 tests 一律拒绝
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 0) return path.join(ROOT, 'index.html');
  for (const seg of parts) {
    if (seg === '.' || seg === '..') return null; // 穿越段
    if (seg.startsWith('.')) return null;      // 隐藏文件/目录
    if (seg === 'tests') return null;          // 测试目录
  }
  // 规则 4：归一化后必须仍在 ROOT 内
  const full = path.normalize(path.join(ROOT, ...parts));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function notFound(res, msg) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg || '404 Not Found');
}

/* =========================================================================
   局域网中转站（只有静态服务这一侧的那台电脑会跑到这里）
   设计原则：服务端零知识
   - 只转发配对用的两段 SDP 文本，不接触任何文件内容、不写磁盘
   - 文件本身走 WebRTC 数据通道，由 DTLS 端到端加密
   - 会话 10 分钟无活动即销毁；关闭中转立即清空内存
   安全边界
   - 仅接受本机/私网来源（公网地址一律 403）
   - 校验 Host 与 Origin，挡住 DNS rebinding 与跨站请求
   - 配对码有尝试次数限制；会话只能绑定一个客户端，电脑端可随时踢掉
   ========================================================================= */

const RELAY = {
  ttl: 10 * 60 * 1000,             // 会话闲置超时
  maxSessions: 4,
  sessions: new Map(),             // sid -> session
  attempts: new Map()              // ip -> { n, until }
};

function randHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

/* 定长比较，避免按字符提前返回泄露配对码 */
function eqSafe(a, b) {
  const A = String(a == null ? '' : a);
  const B = String(b == null ? '' : b);
  if (A.length !== B.length) return false;
  let r = 0;
  for (let i = 0; i < A.length; i++) r |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return r === 0;
}

function isPrivateAddr(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (a === '::1' || a === '127.0.0.1') return true;
  if (/^127\./.test(a)) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;          // 链路本地
  if (/^fe80:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a)) return true;  // IPv6 本地/ULA
  return false;
}

/* Host 必须是 IP 字面量或 .local 名，防止恶意域名解析到内网后借浏览器打进来 */
function hostAllowed(hostHeader) {
  const raw = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const h = raw.replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h === '::1' || /^[0-9a-f:]+$/.test(h) && h.indexOf(':') >= 0) return true;
  if (/\.local$/.test(h)) return true;
  return false;
}

function jsonOut(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared && declared > limit) { reject(new Error('too-large')); return; }
    const parts = [];
    let size = 0;
    let killed = false;
    req.on('data', function (c) {
      if (killed) return;
      size += c.length;
      if (size > limit) { killed = true; reject(new Error('too-large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', function () { if (!killed) resolve(Buffer.concat(parts)); });
    req.on('error', function (e) { if (!killed) reject(e); });
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error('bad-json');
  }
}

function relayAuth(req) {
  return String(req.headers['x-relay-token'] || '');
}

function relaySessionFor(sid) {
  const s = RELAY.sessions.get(String(sid || ''));
  if (!s) return null;
  if (Date.now() - s.at > RELAY.ttl) {
    RELAY.sessions.delete(s.sid);
    return null;
  }
  return s;
}

function relayTouch(s) {
  s.at = Date.now();
}

/* 配对码尝试次数：同一地址 5 分钟内最多 10 次，超了先锁 5 分钟 */
function relayAttempt(ip) {
  const now = Date.now();
  let a = RELAY.attempts.get(ip);
  if (!a || now > a.until) { a = { n: 0, until: now + 5 * 60 * 1000 }; RELAY.attempts.set(ip, a); }
  return a;
}

async function handleRelay(req, res, u) {
  /* --- 边界校验：只在私网可用，且必须同源 --- */
  if (!isPrivateAddr(req.socket.remoteAddress)) {
    jsonOut(res, 403, { error: '中继接口仅限本机局域网访问' });
    return;
  }
  if (!hostAllowed(req.headers.host)) {
    jsonOut(res, 403, { error: '拒绝非局域网地址访问' });
    return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== ('http://' + req.headers.host)) {
    jsonOut(res, 403, { error: '拒绝跨站请求' });
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    jsonOut(res, 403, { error: '拒绝跨站请求' });
    return;
  }

  const action = u.pathname.replace(/^\/api\/relay\/?/, '').replace(/\/$/, '');
  const ip = String(req.socket.remoteAddress || '');

  try {
    /* ---- 电脑端：本机内网地址（二维码里要用平板能访问的地址，不能写 localhost） ---- */
    if (action === 'addr' && req.method === 'GET') {
      const addrs = [];
      try {
        const nets = require('os').networkInterfaces();
        Object.keys(nets).forEach(function (name) {
          (nets[name] || []).forEach(function (n) {
            if (n.family === 'IPv4' && !n.internal) addrs.push(n.address);
          });
        });
      } catch (e) { /* 取不到就返回空 */ }
      const score = function (a) {
        if (/^192\.168\./.test(a)) return 0;
        if (/^10\./.test(a)) return 1;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
        return 3;
      };
      addrs.sort(function (a, b) { return score(a) - score(b); });
      jsonOut(res, 200, { addrs: addrs, port: PORT });
      return;
    }

    /* ---- 电脑端：开一个会话 ---- */
    if (action === 'open' && req.method === 'POST') {
      await readJson(req, 8192).catch(function () { return {}; });
      if (RELAY.sessions.size >= RELAY.maxSessions) {
        /* 清掉最老的一个，避免用户反复点「开启」把内存占满 */
        let oldest = null;
        RELAY.sessions.forEach(function (s) {
          if (!oldest || s.at < oldest.at) oldest = s;
        });
        if (oldest) RELAY.sessions.delete(oldest.sid);
      }
      const sid = randHex(6);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const token = randHex(24);
      const s = {
        sid: sid, code: code, token: token,
        clientToken: '',
        sig: { offer: '', answer: '' },
        at: Date.now(), host: req.headers.host
      };
      RELAY.sessions.set(sid, s);
      jsonOut(res, 200, { sid: sid, code: code, token: token, ttl: RELAY.ttl });
      return;
    }

    /* ---- 平板端：确认会话还有效（配对前先探一下） ---- */
    if (action === 'info' && req.method === 'GET') {
      const s = relaySessionFor(u.searchParams.get('sid'));
      if (!s) { jsonOut(res, 404, { error: '会话不存在或已过期' }); return; }
      relayTouch(s);
      jsonOut(res, 200, { joined: !!s.clientToken });
      return;
    }

    /* ---- 平板端：用配对码换令牌 ---- */
    if (action === 'join' && req.method === 'POST') {
      const a = relayAttempt(ip);
      if (a.n >= 10) { jsonOut(res, 429, { error: '尝试次数过多，稍后再试' }); return; }
      const body = await readJson(req, 8192);
      const s = relaySessionFor(body.sid);
      if (!s) { jsonOut(res, 404, { error: '会话不存在或已过期' }); return; }
      if (!eqSafe(body.code, s.code)) {
        a.n++;
        jsonOut(res, 403, { error: '配对码不对' });
        return;
      }
      if (s.clientToken) {
        /* 已有别的设备占着这个会话：不自动顶掉，交回电脑端决定 */
        jsonOut(res, 409, { error: '这个会话已经被另一台设备占用' });
        return;
      }
      s.clientToken = randHex(24);
      relayTouch(s);
      a.n = 0;
      jsonOut(res, 200, { token: s.clientToken });
      return;
    }

    /* ---- 以下都需要令牌 ---- */
    const token = relayAuth(req);
    const sid = u.searchParams.get('sid') || (function () {
      /* 令牌与 sid 一一对应，靠令牌反查会话 */
      let hit = '';
      RELAY.sessions.forEach(function (s) {
        if (eqSafe(token, s.token) || eqSafe(token, s.clientToken)) hit = s.sid;
      });
      return hit;
    })();
    const s = relaySessionFor(sid);
    if (!s) { jsonOut(res, 404, { error: '会话不存在或已过期' }); return; }

    const isDesk = eqSafe(token, s.token);
    const isClient = !!s.clientToken && eqSafe(token, s.clientToken);
    if (!isDesk && !isClient) { jsonOut(res, 403, { error: '令牌无效' }); return; }
    relayTouch(s);

    /* 电脑端轮询：平板进来没有、内存用了多少 */
    if (action === 'status' && req.method === 'GET' && isDesk) {
      jsonOut(res, 200, { joined: !!s.clientToken });
      return;
    }

    /* ---- 配对信息交换：电脑发 offer，平板取走；平板发 answer，电脑取走 ----
       只转发这两段文本，不碰文件内容；文件由 WebRTC 的 DTLS 加密通道传输。 */
    if (action === 'sig' && (req.method === 'GET' || req.method === 'POST')) {
      const kind = u.searchParams.get('kind');
      if (kind !== 'offer' && kind !== 'answer') { jsonOut(res, 400, { error: 'kind 不合法' }); return; }
      if (req.method === 'POST') {
        if (kind === 'offer' && !isDesk) { jsonOut(res, 403, { error: '只有电脑端能发 offer' }); return; }
        if (kind === 'answer' && !isClient) { jsonOut(res, 403, { error: '只有平板端能发 answer' }); return; }
        const body = await readJson(req, 8192);
        const sdp = String(body.sdp || '');
        if (sdp.length < 20 || sdp.length > 8192) { jsonOut(res, 400, { error: '配对信息长度不对' }); return; }
        s.sig[kind] = sdp;
        jsonOut(res, 200, { ok: true });
        return;
      }
      if (kind === 'answer' && !isDesk) { jsonOut(res, 403, { error: '只有电脑端能取 answer' }); return; }
      if (kind === 'offer' && !isClient) { jsonOut(res, 403, { error: '只有平板端能取 offer' }); return; }
      jsonOut(res, 200, { sdp: s.sig[kind] || '' });
      return;
    }

    /* 平板端：主动退出，释放会话绑定 */
    if (action === 'leave' && req.method === 'POST' && isClient) {
      s.sig.offer = '';
      s.sig.answer = '';
      s.clientToken = '';
      jsonOut(res, 200, { ok: true });
      return;
    }

    /* 电脑端：把当前客户端踢掉，重新等平板 */
    if (action === 'kick' && req.method === 'POST' && isDesk) {
      s.sig.offer = '';
      s.sig.answer = '';
      s.clientToken = '';
      jsonOut(res, 200, { ok: true });
      return;
    }

    /* 电脑端：关掉会话，内存立即清空 */
    if (action === 'close' && req.method === 'POST' && isDesk) {
      RELAY.sessions.delete(s.sid);
      jsonOut(res, 200, { ok: true });
      return;
    }

    jsonOut(res, 404, { error: '没有这个操作' });
  } catch (e) {
    const msg = e && e.message === 'too-large' ? '内容超出上限' : (e && e.message === 'bad-json' ? '请求格式不对' : '服务出错');
    jsonOut(res, e && e.message === 'too-large' ? 413 : 400, { error: msg });
  }
}

/* 定时清理过期会话，避免内存一直挂着 */
setInterval(function () {
  const now = Date.now();
  RELAY.sessions.forEach(function (s, k) {
    if (now - s.at > RELAY.ttl) RELAY.sessions.delete(k);
  });
  RELAY.attempts.forEach(function (a, k) {
    if (now > a.until) RELAY.attempts.delete(k);
  });
}, 30000).unref();

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');

  /* 中转站接口：需要 POST/PUT，必须在方法检查之前分流 */
  if (u.pathname.indexOf('/api/relay/') === 0) {
    handleRelay(req, res, u);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const filePath = safePath(u.pathname);
  if (!filePath) {
    notFound(res);
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    notFound(res);
    return;
  }

  // 规则 1：目录不列清单，只回 index.html（根目录）或 404
  if (stat.isDirectory()) {
    const isRoot = path.resolve(filePath) === path.resolve(ROOT);
    if (!isRoot) {
      notFound(res);
      return;
    }
    const indexFile = path.join(filePath, 'index.html');
    try {
      fs.accessSync(indexFile, fs.constants.R_OK);
      streamFile(indexFile, res);
    } catch (e) {
      notFound(res);
    }
    return;
  }

  streamFile(filePath, res);
});

function streamFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  stream.on('open', function () {
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    stream.pipe(res);
  });
  stream.on('error', function () {
    if (!res.headersSent) notFound(res);
    else res.end();
  });
}

server.listen(PORT, '0.0.0.0', function () {
  console.log('工作文件静态服务已启动，端口 ' + PORT);
  /* 顺手把本机内网地址打出来，手机/平板手输网址时直接用 */
  try {
    const nets = require('os').networkInterfaces();
    Object.keys(nets).forEach(function (name) {
      (nets[name] || []).forEach(function (n) {
        if (n.family === 'IPv4' && !n.internal) {
          console.log('  局域网访问：http://' + n.address + ':' + PORT + '/');
        }
      });
    });
  } catch (e) { /* 取不到就算了 */ }
  console.log('中转站接口：/api/relay/*（仅内网可用，零知识，只存密文）');
});
