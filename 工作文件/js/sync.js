/*
 * 局域网同步（WebRTC 点对点）
 * - 无需服务器、无需账号：两端在同一 WiFi 下直连
 * - 单向为主：电脑（desk）→ 手机（phone），手机新增内容不回传，避免冲突
 * - 增量：按 updatedAt 比对，只传变化的文档本体
 * - 实时：连接保持时监听数据库写入，变更立即推送
 * - 选择：电脑端收到手机的差额清单后，可勾选要发哪些文件
 * - 对账：发完由手机端回报实际入库的 id，缺失自动补传，仍缺则列出文件名
 *
 * 消息分片：浏览器对 WebRTC 单条消息有硬上限（约 256KB），超限 dc.send 会抛异常。
 * 带正文/识别文本的文档元信息很容易超限，所以凡超过 SAFE_MSG 的 JSON 一律按 FRAG
 * 切开发送、对端重组 —— 否则那条 doc-begin 会被静默丢掉，整份文件随之消失。
 */

(function () {
  const PROTO = 2;
  const CHANNEL = 'workfile-sync';
  const CHUNK = 16 * 1024;            // 单个数据块 16KB
  const SAFE_MSG = 100 * 1024;        // 单条 JSON 消息的安全字节上限
  const FRAG = 12 * 1024;             // 超限消息的切片长度（按字符，中文最多 3 字节/字）
  const LEGACY_SLICE = 40 * 1024;     // 旧版本清单分片大小（兼容用）
  const LEGACY_WAIT = 6000;           // 等不到新协议回应就切兼容模式
  const BUFFER_HIGH = 1024 * 1024;    // 发送缓冲上限 1MB
  const AUDIT_WAIT = 45000;           // 等对账结果的兜底时间

  let pc = null;
  let dc = null;
  let role = null;            // 'desk'（电脑，数据源）| 'phone'（手机，接收方）
  let connected = false;
  let busy = false;           // 正在同步
  let incoming = {};          // 接收中的文档：id -> { meta, chunks, received, size, total }
  let remoteMeta = {};        // 远端文档元信息 id -> meta
  let stats = { sent: 0, recv: 0, bytes: 0, startedAt: 0 };
  let handlers = {};

  let fragBox = {};           // 分片重组：bid -> { parts:[], total }
  let fragSeq = 0;

  let peerProto = PROTO;      // 对端协议版本（收到 hello 后才知道真实的）
  let legacyTimer = null;     // 等不到对端新协议回应时的兼容模式切换
  let manifestParts = [];     // 旧版本清单分片（兼容用）
  let manifestTotal = 0;
  let lastManifest = null;    // 本轮清单对象，切兼容模式时重新按旧格式发

  let expectIds = [];         // 手机端：本轮应收到哪些 id
  let gotIds = {};            // 手机端：已成功入库的 id
  let finishing = 0;          // 手机端：正在落库的 doc-end 数量（避免对账过早）
  let auditSent = false;      // 手机端：本轮是否已回报过对账结果
  let lastPlan = null;        // 电脑端：最近一次收到的差额清单
  let sentNames = {};         // 电脑端：id -> 文件名（对账时显示用）
  let auditRetry = 0;         // 电脑端：本轮已补传次数
  let auditTimer = null;
  let pendingPush = new Set();   // 同步期间电脑端产生的变更，结束后补发
  let pendingRemove = new Set();

  /* ---------- 事件 ---------- */

  function on(name, fn) {
    (handlers[name] = handlers[name] || []).push(fn);
  }

  function emit(name, payload) {
    (handlers[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.warn('[sync] handler error', e); }
    });
  }

  function state() {
    return {
      connected: connected,
      role: role,
      busy: busy,
      proto: PROTO,
      peerProto: peerProto,
      legacy: peerProto !== PROTO,
      stats: Object.assign({}, stats)
    };
  }

  /* ---------- 新旧版本兼容 ----------
     协议 2 的清单是一条大消息 + plan/go 协商；协议 1 是分片清单 + 直接点单。
     两端版本不一致时不能干等，-- 等不到对端新协议回应就自动退回旧格式。 */

  function startLegacyTimer() {
    stopLegacyTimer();
    /* 已经握手知道对端是旧版本就几乎立刻退回，否则等一会儿看有没有新协议回应 */
    const delay = peerProto === PROTO ? LEGACY_WAIT : 800;
    legacyTimer = setTimeout(function () {
      legacyTimer = null;
      if (!busy || !connected) return;
      toLegacy().catch(function () { /* 连接已断 */ });
    }, delay);
  }

  function stopLegacyTimer() {
    if (legacyTimer) { clearTimeout(legacyTimer); legacyTimer = null; }
  }

  async function toLegacy() {
    peerProto = 1;
    emit('peer-old', { proto: 1 });
    if (role === 'desk') await sendLegacyManifest();
    else if (lastPlan) send({ t: 'need', ids: lastPlan.need || [] });
  }

  /* 电脑端：把清单按旧格式（40KB 分片）再发一遍，旧手机端才认 */
  async function sendLegacyManifest() {
    if (!lastManifest) return;
    let json;
    try { json = JSON.stringify(lastManifest); } catch (e) { return; }
    const parts = sliceString(json, LEGACY_SLICE);
    for (let i = 0; i < parts.length; i++) {
      send({ t: 'manifest-part', seq: i, total: parts.length, data: parts[i] });
      if (i % 10 === 0) await sleep(0);
    }
    send({ t: 'manifest-end', total: parts.length, count: (lastManifest.docs || []).length });
    emit('progress', {
      stage: '手机端是旧版本，已按兼容模式重新发送清单',
      current: 0, total: (lastManifest.docs || []).length, bytes: 0
    });
  }

  /* 手机端：收到旧格式清单，重组后照常走 onManifest */
  function onLegacyManifest() {
    const json = manifestParts.join('');
    manifestParts = [];
    manifestTotal = 0;
    let mf;
    try { mf = JSON.parse(json); } catch (e) {
      emit('error', { message: '清单解析失败，请重新配对' });
      return;
    }
    onManifest(mf);
  }


  /* ---------- 连接 ---------- */

  function reset() {
    stopWatch();
    stopLegacyTimer();
    if (auditTimer) { clearTimeout(auditTimer); auditTimer = null; }
    try { if (dc) dc.close(); } catch (e) { /* 忽略 */ }
    try { if (pc) pc.close(); } catch (e) { /* 忽略 */ }
    dc = null;
    pc = null;
    connected = false;
    busy = false;
    incoming = {};
    remoteMeta = {};
    fragBox = {};
    fragSeq = 0;
    peerProto = PROTO;
    manifestParts = [];
    manifestTotal = 0;
    lastManifest = null;
    expectIds = [];
    gotIds = {};
    lastPlan = null;
    sentNames = {};
    auditRetry = 0;
    pendingPush = new Set();
    pendingRemove = new Set();
    stats = { sent: 0, recv: 0, bytes: 0, startedAt: 0 };
  }

  /* 等 ICE 收集结束。平板网卡多，收集慢，但同 WiFi 只要有内网 IPv4 候选就够用，
     所以「拿到内网 IPv4 且候选不再新增」就收工，最多等 8 秒。 */
  function waitIce(conn) {
    return new Promise(function (resolve) {
      if (conn.iceGatheringState === 'complete') return resolve();
      let done = false;
      let lastAt = Date.now();
      let hasLan = false;
      let tick = null;

      const finish = function () {
        if (done) return;
        done = true;
        if (tick) clearInterval(tick);
        clearTimeout(cap);
        resolve();
      };
      const cap = setTimeout(finish, 8000);

      const check = function () {
        if (conn.iceGatheringState === 'complete') return finish();
        if (hasLan && Date.now() - lastAt > 700) return finish();
      };

      conn.addEventListener('icecandidate', function (e) {
        lastAt = Date.now();
        if (!e.candidate) return finish();   /* null = 收集结束 */
        const raw = e.candidate.candidate || '';
        const parts = raw.split(' ');
        const addr = e.candidate.address || parts[4] || '';
        if (isLanV4(addr)) hasLan = true;
      });
      conn.addEventListener('icegatheringstatechange', function () {
        if (conn.iceGatheringState === 'complete') finish();
      });

      tick = setInterval(function () {
        if (done) return;
        check();
      }, 200);
    });
  }

  function bindPc(conn) {
    conn.oniceconnectionstatechange = function () {
      const st = conn.iceConnectionState;
      if (st === 'failed') {
        emit('error', { message: '局域网连接失败，请确认两台设备在同一 WiFi 下，然后重新配对' });
        connected = false;
        emit('state', state());
      } else if (st === 'disconnected') {
        emit('state', state());
      }
    };
  }

  function bindChannel(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onopen = function () {
      connected = true;
      stats.startedAt = Date.now();
      emit('state', state());
      if (role === 'desk') {
        sendHello();
        hookLive();
      }
    };
    ch.onclose = function () {
      connected = false;
      emit('state', state());
    };
    ch.onerror = function () {
      emit('error', { message: '数据传输通道出错，请重新配对' });
    };
    ch.onmessage = function (e) {
      try {
        if (e.data instanceof ArrayBuffer) handleBinary(e.data);
        else handleText(JSON.parse(e.data));
      } catch (err) {
        console.warn('[sync] 消息处理失败', err);
      }
    };
  }

  function send(obj) {
    if (!dc || dc.readyState !== 'open') return false;
    try { dc.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function byteLen(str) {
    try {
      if (window.TextEncoder) return new TextEncoder().encode(str).length;
    } catch (e) { /* 降级 */ }
    return str.length * 3;
  }

  /* 大消息自动切片：返回 false 表示通道已断或发送失败，调用方必须处理 */
  async function sendLarge(obj) {
    if (!dc || dc.readyState !== 'open') return false;
    let json;
    try { json = JSON.stringify(obj); } catch (e) { return false; }
    if (byteLen(json) <= SAFE_MSG) return send(obj);

    const parts = sliceString(json, FRAG);
    const bid = ++fragSeq;
    for (let i = 0; i < parts.length; i++) {
      /* 几 MB 的清单一次灌满发送缓冲会被丢掉，按缓冲水位让一下 */
      if (i % 8 === 0) await waitBuffer();
      const ok = send({ t: 'frag', bid: bid, seq: i, total: parts.length, data: parts[i] });
      if (!ok) return false;
    }
    return true;
  }

  function onFrag(msg) {
    let box = fragBox[msg.bid];
    if (!box) box = fragBox[msg.bid] = { parts: [], total: msg.total || 0, got: 0 };
    if (box.parts[msg.seq] === undefined) box.got++;
    box.parts[msg.seq] = msg.data;
    box.total = msg.total || box.total;
    if (box.got < box.total) return;
    delete fragBox[msg.bid];
    try {
      handleText(JSON.parse(box.parts.join('')));
    } catch (e) {
      console.warn('[sync] 分片重组失败', e);
      emit('error', { message: '接收数据时出错，请重新配对后再同步' });
    }
  }

  function sendHello() {
    send({ t: 'hello', proto: PROTO, role: 'desk', device: '电脑' });
  }

  /* ---------- 配对码瘦身 ----------
     平板/多网卡设备会攒出十几个 ICE 候选（WiFi、蜂窝、IPv6、VPN 都有），
     全塞进 SDP 后配对码能到两三千字符，二维码密到扫不出来、也过不了微信压缩。
     同 WiFi 直连真正用得上的只有「内网 IPv4 host 候选」，其余全是噪音。
     保守策略：一个内网 IPv4 都找不到时原样返回，绝不把连接搞坏。 */

  function isLanV4(addr) {
    if (!addr || addr.indexOf(':') >= 0) return false;
    return /^10\./.test(addr) || /^192\.168\./.test(addr) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
  }

  function trimSdp(sdp) {
    const text = String(sdp || '');
    /* 末尾的空行是 SDP 的结束标记，必须留在最后；先剔干净再自己补 */
    const lines = text.split(/\r?\n/).filter(function (l) { return l.length > 0; });
    const cand = [];
    const rest = [];
    lines.forEach(function (l) {
      if (l.indexOf('a=candidate:') === 0) cand.push(l);
      else rest.push(l);
    });
    /* 候选本来就不多，没必要动 */
    if (cand.length <= 3) return text;

    const lan = [];
    cand.forEach(function (l) {
      const p = l.split(' ');
      const addr = p[4] || '';
      if (isLanV4(addr)) lan.push({ line: l, addr: addr });
    });
    if (!lan.length) return text;

    /* 优先 192.168 网段（家用路由器最常见），最多留 3 条 */
    lan.sort(function (a, b) {
      const score = function (x) {
        if (/^192\.168\./.test(x.addr)) return 0;
        if (/^10\./.test(x.addr)) return 1;
        return 2;
      };
      return score(a) - score(b) || (a.addr < b.addr ? -1 : 1);
    });
    const keep = lan.slice(0, 3).map(function (x) { return x.line; });

    return rest.concat(keep).join('\r\n') + '\r\n';
  }

  /* 电脑端：生成配对码（offer） */
  async function createOffer() {
    reset();
    role = 'desk';
    pc = new RTCPeerConnection({ iceServers: [] });
    bindPc(pc);
    dc = pc.createDataChannel(CHANNEL, { ordered: true });
    bindChannel(dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    emit('state', state());
    return trimSdp(pc.localDescription.sdp);
  }

  /* 手机端：接收 offer，返回 answer */
  async function acceptOffer(sdp) {
    reset();
    role = 'phone';
    pc = new RTCPeerConnection({ iceServers: [] });
    bindPc(pc);
    pc.ondatachannel = function (e) {
      dc = e.channel;
      bindChannel(dc);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await waitIce(pc);
    emit('state', state());
    return trimSdp(pc.localDescription.sdp);
  }

  /* 电脑端：接收手机返回的 answer */
  async function acceptAnswer(sdp) {
    if (!pc) throw new Error('请先生成配对码');
    await pc.setRemoteDescription({ type: 'answer', sdp: sdp });
    emit('state', state());
  }

  function disconnect() {
    reset();
    emit('state', state());
  }

  /* ---------- 协议处理 ---------- */

  function handleText(msg) {
    switch (msg.t) {
      case 'hello':
        /* 对端版本只做记录，不阻断：旧版本走兼容模式，见 fallbackLegacy* */
        peerProto = msg.proto || 1;
        if (peerProto !== PROTO) {
          emit('peer-old', { proto: peerProto });
        }
        emit('progress', { stage: '握手完成', current: 0, total: 0, bytes: 0 });
        break;

      case 'frag':
        onFrag(msg);
        break;

      case 'manifest':
        onManifest(msg);
        break;

      /* 旧版本（PROTO 1）的清单分片：新端照样能收，方便新旧混用 */
      case 'manifest-part':
        manifestParts[msg.seq] = msg.data;
        manifestTotal = msg.total || manifestTotal;
        break;

      case 'manifest-end':
        onLegacyManifest();
        break;

      case 'plan':
        onPlan(msg);
        break;

      case 'go':
        onGo(msg);
        break;

      case 'audit':
        onAudit(msg);
        break;

      case 'need':
        /* 旧版本手机端直接点单：按兼容模式发送，不做对账（旧端不会回报） */
        stopLegacyTimer();
        peerProto = peerProto === PROTO ? 1 : peerProto;
        sendDocs(msg.ids || []);
        break;

      case 'doc-begin':
        incoming[msg.id] = { meta: msg.meta, size: msg.size, chunks: [], received: 0, total: msg.total };
        break;

      case 'doc-end':
        startFinish(msg);
        break;

      case 'doc-meta-only':
        onMetaOnly(msg);
        break;

      case 'memo':
        applyMemos(msg.list || []);
        break;

      case 'memo-del':
        deleteMemos(msg.ids || []);
        break;

      case 'folders':
        applyFolders(msg.list || []);
        break;

      case 'del':
        onRemoteDelete(msg.id);
        break;

      case 'done':
        onRemoteDone(msg);
        break;

      case 'ping':
        send({ t: 'pong' });
        break;

      default:
        break;
    }
  }

  function handleBinary(buf) {
    if (buf.byteLength < 8) return;
    const dv = new DataView(buf);
    const id = dv.getUint32(0, true);
    const seq = dv.getUint32(4, true);
    const box = incoming[id];
    if (!box) return;
    const chunk = buf.slice(8);
    box.chunks[seq] = chunk;
    box.received += chunk.byteLength;
    stats.recv++;
    emit('progress', {
      stage: '接收文件',
      current: Object.keys(incoming).length ? 1 : 0,
      total: 1,
      bytes: stats.bytes + box.received
    });
    emit('file-progress', { id: id, name: box.meta ? box.meta.name : '', received: box.received, size: box.size });
  }

  /* doc-end 的处理是异步的（要落库），done 消息可能先到。
     这里记在途数量，对账前等它们落完，否则会把刚写完的文件误报成缺失。 */
  function startFinish(msg) {
    finishing++;
    Promise.resolve(finishDoc(msg)).catch(function (e) {
      console.warn('[sync] 落库失败', e);
    }).then(function () { finishing--; });
  }

  function onRemoteDone(msg) {
    if (role === 'phone') { reportAudit(); return; }
    busy = false;
    emit('done', { docs: msg.docs || 0, bytes: stats.bytes, from: msg.from || '' });
    emit('state', state());
  }

  /* ---------- 电脑端：发清单 ---------- */

  async function startSync() {
    if (!connected || role !== 'desk') throw new Error('请先完成配对');
    if (busy) return { already: true };
    busy = true;
    auditRetry = 0;
    sentNames = {};
    stats = { sent: 0, recv: 0, bytes: 0, startedAt: Date.now() };
    emit('state', state());
    emit('progress', { stage: '正在整理文件清单', current: 0, total: 0, bytes: 0 });
    await sendManifest();
    return { started: true };
  }

  async function sendManifest() {
    const docs = await DB.allDocuments();
    const series = await DB.listSeries();
    let memos = [];
    try { memos = await DB.db.memos.toArray(); } catch (e) { /* 旧库 */ }
    let folders = [];
    try { folders = await DB.db.folders.toArray(); } catch (e) { /* 旧库 */ }

    const metas = docs.map(function (d) {
      const c = {};
      Object.keys(d).forEach(function (k) { if (k !== 'blob') c[k] = d[k]; });
      c.hasBlob = !!d.blob;
      return c;
    });

    lastManifest = { t: 'manifest', proto: PROTO, docs: metas, series: series, memos: memos, folders: folders };
    const ok = await sendLarge(lastManifest);
    if (!ok) {
      busy = false;
      emit('error', { message: '清单发送失败，连接可能已断开，请重新配对' });
      emit('state', state());
      return;
    }
    emit('progress', { stage: '等待手机端核对差额（共 ' + metas.length + ' 份）', current: 0, total: metas.length, bytes: 0 });
    /* 手机端若是旧版本，不认识这条清单，6 秒后自动改发旧格式 */
    startLegacyTimer();
  }

  /* 手机端算完差额后回报：电脑端据此弹出选择面板 */
  function onPlan(msg) {
    stopLegacyTimer();
    lastPlan = { need: msg.need || [], total: msg.total || 0, metaOnly: msg.metaOnly || 0, sizes: msg.sizes || {} };
    emit('plan', lastPlan);
    /* 手机端没有任何缺失时不必让用户空等，直接放行 */
    if (!lastPlan.need.length) {
      sendSelected([]).catch(function () { /* 连接已断 */ });
      return;
    }
    setStage();
  }

  function setStage() {
    const total = lastPlan ? lastPlan.need.length : 0;
    emit('progress', { stage: '请勾选要发到手机的文件（' + total + ' 份待选）', current: 0, total: total, bytes: 0 });
  }

  /* 电脑端：用户勾选完毕后开始发送 */
  async function sendSelected(ids) {
    if (!connected || role !== 'desk') throw new Error('请先完成配对');
    const list = (ids || []).filter(function (x) { return x != null; });
    auditRetry = 0;
    busy = true;
    emit('state', state());
    /* 先告诉手机端「这一轮会收到哪些 id」，手机端据此建预期清单；
       有序通道保证 go 一定先于任何 doc-begin 到达 */
    send({ t: 'go', ids: list });
    await sendDocs(list, { keepBusy: true });
  }

  async function sendDocs(ids, opts) {
    opts = opts || {};
    if (!ids.length) {
      send({ t: 'done', docs: 0, from: 'desk' });
      if (opts.keepBusy) armAudit();
      else {
        busy = false;
        emit('done', { docs: 0, bytes: 0, from: 'desk' });
        emit('state', state());
      }
      return;
    }
    const total = ids.length;
    let doneCount = 0;
    const okIds = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const name = await sendOneDoc(id);
      if (name) { sentNames[id] = name; okIds.push(id); }
      doneCount++;
      emit('progress', {
        stage: '发送文件',
        current: doneCount,
        total: total,
        bytes: stats.bytes,
        name: name || ''
      });
    }
    send({ t: 'done', docs: total, from: 'desk' });
    /* 只把真正发出去的记入快照；失败的留给对账补传，不能被误标成「已同步」 */
    await syncSnapshotFor(okIds);
    if (opts.keepBusy) {
      armAudit();
      return;
    }
    busy = false;
    emit('done', { docs: total, bytes: stats.bytes, from: 'desk' });
    emit('state', state());
  }

  /* 对账兜底：手机端迟迟不回报结果时不要让界面永远卡在「同步中」 */
  function armAudit() {
    if (auditTimer) clearTimeout(auditTimer);
    /* 旧版本对端不会回报对账，直接收尾 */
    if (peerProto !== PROTO) {
      busy = false;
      emit('done', { docs: Object.keys(sentNames).length, bytes: stats.bytes, from: 'desk' });
      emit('state', state());
      return;
    }
    auditTimer = setTimeout(function () {
      auditTimer = null;
      if (!busy) return;
      busy = false;
      emit('audit', { ok: false, timeout: true, missing: [], names: [], expect: 0, got: 0 });
      emit('done', { docs: Object.keys(sentNames).length, bytes: stats.bytes, from: 'desk' });
      emit('state', state());
    }, AUDIT_WAIT);
  }

  /* 电脑端：收到手机端的对账结果 */
  async function onAudit(msg) {
    if (auditTimer) { clearTimeout(auditTimer); auditTimer = null; }
    const missing = (msg.missing || []).filter(function (id) { return id != null; });

    if (missing.length && auditRetry < 2) {
      auditRetry++;
      emit('progress', {
        stage: '对账发现 ' + missing.length + ' 份未到达，正在补传（第 ' + auditRetry + ' 次）',
        current: 0, total: missing.length, bytes: stats.bytes
      });
      send({ t: 'go', ids: missing });
      await sendDocs(missing, { keepBusy: true });
      return;
    }

    busy = false;
    const names = missing.map(function (id) { return sentNames[id] || ('#' + id); });
    emit('audit', {
      ok: !missing.length,
      missing: missing,
      names: names,
      expect: msg.expect || 0,
      got: msg.got || 0
    });
    await flushPending();
    emit('done', { docs: msg.got || Object.keys(sentNames).length, bytes: stats.bytes, from: 'desk' });
    emit('state', state());
  }

  async function syncSnapshotFor(ids) {
    if (!snapshot || !ids || !ids.length) return;
    try {
      const docs = await DB.db.documents.toArray();
      const map = new Map();
      docs.forEach(function (d) { map.set(d.id, d.updatedAt || d.createdAt || 0); });
      ids.forEach(function (id) { if (map.has(id)) snapshot.set(id, map.get(id)); });
    } catch (e) { /* 忽略 */ }
  }

  async function sendOneDoc(id) {
    const doc = await DB.getDocument(id);
    if (!doc) {
      send({ t: 'doc-begin', id: id, size: 0, total: 0, meta: null });
      send({ t: 'doc-end', id: id, missing: true });
      return '';
    }
    if (!doc.blob) {
      /* 元信息可能很长，必须走分片，否则 dc.send 抛错后这条记录会凭空消失 */
      if (!(await sendLarge({ t: 'doc-meta-only', id: id, meta: stripBlob(doc) }))) return '';
      return doc.name;
    }
    const buf = await doc.blob.arrayBuffer();
    const total = Math.ceil(buf.byteLength / CHUNK);
    /* doc-begin 带整份正文与识别文本，是最容易超限的一条消息 */
    if (!(await sendLarge({ t: 'doc-begin', id: id, size: buf.byteLength, total: total, meta: stripBlob(doc) }))) {
      emit('progress', { stage: '「' + doc.name + '」头部信息发送失败，将在对账后重试', current: 0, total: 0, bytes: stats.bytes });
      return '';
    }
    for (let i = 0; i < total; i++) {
      await waitBuffer();
      const piece = buf.slice(i * CHUNK, Math.min(buf.byteLength, (i + 1) * CHUNK));
      const frame = new ArrayBuffer(8 + piece.byteLength);
      const dv = new DataView(frame);
      dv.setUint32(0, id, true);
      dv.setUint32(4, i, true);
      new Uint8Array(frame, 8).set(new Uint8Array(piece));
      try {
        dc.send(frame);
      } catch (e) {
        return '';   /* 通道已断，交给对账与重连 */
      }
      stats.sent++;
      stats.bytes += piece.byteLength;
    }
    send({ t: 'doc-end', id: id });
    return doc.name;
  }

  function waitBuffer() {
    return new Promise(function (resolve) {
      /* 这里必须抓住当时的通道句柄：等待期间如果断开配对，dc 会被置空，
         定时器或回调里再去读 dc.xxx 就会抛 null 错误（同步结束时必现） */
      const ch = dc;
      if (!ch || ch.readyState !== 'open') return resolve();
      if (ch.bufferedAmount < BUFFER_HIGH) return resolve();
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        try { ch.removeEventListener('bufferedamountlow', onLow); } catch (e) { /* 通道已销毁 */ }
        resolve();
      };
      const onLow = function () { finish(); };
      try {
        ch.bufferedAmountLowThreshold = BUFFER_HIGH / 2;
        ch.addEventListener('bufferedamountlow', onLow);
      } catch (e) {
        return resolve();
      }
      setTimeout(finish, 4000);
    });
  }

  function stripBlob(doc) {
    const c = {};
    Object.keys(doc).forEach(function (k) { if (k !== 'blob') c[k] = doc[k]; });
    return c;
  }

  /* ---------- 手机端：收清单、要文件、落库 ---------- */

  async function onManifest(mf) {
    if (!mf || !Array.isArray(mf.docs)) {
      emit('error', { message: '清单解析失败，请重新配对' });
      return;
    }
    const docs = mf.docs;
    remoteMeta = {};
    docs.forEach(function (d) { remoteMeta[d.id] = d; });

    /* 合并系列与备忘（按 id 去重，远端为准） */
    if (Array.isArray(mf.series) && mf.series.length) {
      await DB.db.series.bulkPut(mf.series);
      emit('remote-series', { count: mf.series.length });
    }
    if (Array.isArray(mf.memos) && mf.memos.length) {
      await DB.db.memos.bulkPut(mf.memos);
      emit('remote-memos', { count: mf.memos.length });
    }
    if (Array.isArray(mf.folders) && mf.folders.length) {
      await applyFolders(mf.folders);
    }

    const locals = await DB.allDocuments();
    const byId = {};
    const byOrigin = {};
    locals.forEach(function (l) {
      byId[l.id] = l;
      if (l.originId) byOrigin[l.originId] = l;
    });

    const need = [];
    const metaOnly = [];
    docs.forEach(function (d) {
      const local = byId[d.id] || byOrigin[d.id];
      const isNewer = !local || (d.updatedAt || 0) > (local.updatedAt || 0) || (d.createdAt || 0) > (local.createdAt || 0);
      if (!isNewer) return;
      if (d.hasBlob) need.push(d.id);
      else metaOnly.push(d);
    });

    /* 无本体的记录类：直接写入（这部分同样计入差额头，之前完全不参与统计） */
    let metaOnlyOk = 0;
    for (let i = 0; i < metaOnly.length; i++) {
      const d = Object.assign({}, metaOnly[i]);
      delete d.hasBlob;
      const local = byId[d.id] || byOrigin[d.id];
      if (local) d.id = local.id;
      else if (byId[d.id]) { d.originId = d.id; delete d.id; }
      try { await DB.db.documents.put(d); metaOnlyOk++; } catch (e) { /* 跳过 */ }
    }
    if (metaOnlyOk) emit('remote-doc', { count: metaOnlyOk });

    /* 不再自行开收：把差额头回报给电脑端，由电脑端勾选后发「go」 */
    gotIds = {};
    expectIds = [];
    auditSent = false;
    busy = true;
    lastPlan = { need: need };
    const sent = await sendLarge({ t: 'plan', need: need, total: docs.length, metaOnly: metaOnlyOk });
    if (!sent) {
      busy = false;
      emit('error', { message: '差额清单回传失败，连接可能已断开，请重新配对' });
      emit('state', state());
      return;
    }
    emit('progress', {
      stage: '核对完成：手机端缺 ' + need.length + ' 份，等待电脑端选择',
      current: 0, total: need.length, bytes: 0
    });
    emit('state', state());
    /* 电脑端若是旧版本，不认识 plan，6 秒后按旧格式直接点单 */
    startLegacyTimer();
  }

  /* 手机端：电脑端已选好，开始接收这一批 */
  function onGo(msg) {
    stopLegacyTimer();
    const ids = Array.isArray(msg.ids) ? msg.ids.filter(function (x) { return x != null; }) : [];
    if (!ids.length) {
      /* 电脑端一份都没选，直接收尾 */
      reportAudit();
      return;
    }
    ids.forEach(function (id) {
      if (expectIds.indexOf(id) < 0) expectIds.push(id);
    });
    auditSent = false;
    emit('progress', {
      stage: '开始接收 ' + ids.length + ' 份',
      current: Object.keys(gotIds).length, total: expectIds.length, bytes: stats.bytes
    });
  }

  async function reportAudit() {
    if (auditSent) return;
    auditSent = true;
    /* 等最后几个 doc-end 落库完成，再算到底缺哪些 */
    let guard = 0;
    while (finishing > 0 && guard++ < 250) await sleep(20);

    const missing = expectIds.filter(function (id) { return !gotIds[id]; });
    const got = Object.keys(gotIds).length;
    const sent = await sendLarge({ t: 'audit', missing: missing, expect: expectIds.length, got: got });
    if (!sent) {
      busy = false;
      emit('error', { message: '对账结果回传失败，连接可能已断开' });
      emit('state', state());
      return;
    }
    if (missing.length) {
      if (peerProto !== PROTO) {
        /* 旧版本电脑端不会补传，别让界面一直等 */
        busy = false;
        emit('progress', {
          stage: '收到 ' + got + ' 份，还有 ' + missing.length + ' 份没到（电脑端是旧版本，无法自动补传）',
          current: got, total: expectIds.length, bytes: stats.bytes
        });
        emit('done', { docs: got, bytes: stats.bytes, from: 'phone' });
        emit('state', state());
        return;
      }
      emit('progress', {
        stage: '有 ' + missing.length + ' 份未写入，正在等电脑端补传',
        current: got, total: expectIds.length, bytes: stats.bytes
      });
      return;
    }
    busy = false;
    expectIds = [];
    emit('done', { docs: got, bytes: stats.bytes, from: 'phone' });
    emit('state', state());
  }

  async function finishDoc(msg) {
    const box = incoming[msg.id];
    if (!box) return;
    delete incoming[msg.id];
    if (msg.missing || !box.meta) return;

    const meta = Object.assign({}, box.meta);
    delete meta.hasBlob;

    /* 完整性校验：块的 seq 有缺口、或累计字节与声明大小不符，都算没收到。
       旧代码直接 new Blob(box.chunks)，缺块也能「成功」，落库的是一份残文件。 */
    let gotCount = 0;
    let gotBytes = 0;
    for (let i = 0; i < box.chunks.length; i++) {
      if (box.chunks[i]) { gotCount++; gotBytes += box.chunks[i].byteLength; }
    }
    const expectCount = box.total || 0;
    const expectBytes = box.size || 0;
    if (gotCount !== expectCount || gotBytes !== expectBytes) {
      emit('error', {
        message: '「' + (meta.name || '文件') + '」传输不完整（' + gotBytes + '/' + expectBytes + ' 字节），已请求补传'
      });
      return;
    }

    const blob = new Blob(box.chunks, { type: 'application/octet-stream' });

    const locals = await DB.allDocuments();
    const byId = {};
    const byOrigin = {};
    locals.forEach(function (l) {
      byId[l.id] = l;
      if (l.originId) byOrigin[l.originId] = l;
    });
    const local = byId[meta.id] || byOrigin[meta.id];

    if (local) {
      meta.id = local.id;
    } else if (byId[meta.id]) {
      /* id 被本机另一份文档占用：作为新记录插入并记住来源 */
      meta.originId = meta.id;
      delete meta.id;
    }
    meta.blob = blob;
    meta.size = blob.size;
    try {
      await DB.db.documents.put(meta);
      gotIds[msg.id] = meta.name || '';
      stats.bytes += blob.size;
      emit('file-done', { name: meta.name });
      emit('remote-doc', { count: 1, name: meta.name });
    } catch (e) {
      emit('error', { message: '写入「' + meta.name + '」失败：' + (e.message || '存储空间不足') });
    }
  }

  /* ---------- 备忘录：电脑改动实时推到手机 ---------- */

  async function applyMemos(list) {
    if (!list.length) return;
    try {
      await DB.db.memos.bulkPut(list);
      emit('remote-memos', { count: list.length });
    } catch (e) { /* 忽略 */ }
  }

  async function deleteMemos(ids) {
    if (!ids.length) return;
    try {
      await DB.db.memos.bulkDelete(ids);
      emit('remote-memos', { count: ids.length });
    } catch (e) { /* 忽略 */ }
  }

  /* 文件夹：电脑端为准，整表覆盖（文件夹里没几行，重建成本低） */
  async function applyFolders(list) {
    if (!list || !list.length) return;
    try {
      await DB.db.folders.clear();
      await DB.db.folders.bulkPut(list);
      emit('remote-folders', { count: list.length });
    } catch (e) { /* 忽略 */ }
  }

  async function onRemoteDelete(id) {
    try {
      const doc = await DB.getDocument(id);
      if (doc) await DB.deleteDocument(id);
      emit('file-deleted', { name: doc ? doc.name : '' });
    } catch (e) { /* 忽略 */ }
  }

  async function onMetaOnly(msg) {
    if (!msg.meta) return;
    const meta = Object.assign({}, msg.meta);
    const locals = await DB.allDocuments();
    const byId = {};
    const byOrigin = {};
    locals.forEach(function (l) {
      byId[l.id] = l;
      if (l.originId) byOrigin[l.originId] = l;
    });
    const local = byId[meta.id] || byOrigin[meta.id];
    if (local) meta.id = local.id;
    else if (byId[meta.id]) { meta.originId = meta.id; delete meta.id; }
    try { await DB.db.documents.put(meta); } catch (e) { /* 跳过 */ }
    emit('remote-doc', { count: 1, name: meta.name });
  }

  /* ---------- 电脑端：实时推送（快照轮询） ---------- */

  let watchTimer = null;
  let snapshot = null;
  let memSnapshot = null;
  let folderSig = '';

  function memoStamp(m) { return m.updatedAt || m.createdAt || 0; }

  function folderSignature(list) {
    return (list || []).map(function (f) { return f.id + ':' + (f.name || '') + ':' + (f.parentId || 0); }).sort().join('|');
  }

  function hookLive() {
    if (watchTimer || role !== 'desk') return;
    refreshSnapshot().then(function () {
      watchTimer = setInterval(tickWatch, 1500);
    });
  }

  async function refreshSnapshot() {
    try {
      const docs = await DB.db.documents.toArray();
      const map = new Map();
      docs.forEach(function (d) { map.set(d.id, d.updatedAt || d.createdAt || 0); });
      snapshot = map;
    } catch (e) {
      snapshot = new Map();
    }
    try {
      const memos = await DB.db.memos.toArray();
      memSnapshot = new Map();
      memos.forEach(function (m) { memSnapshot.set(m.id, memoStamp(m)); });
    } catch (e) {
      memSnapshot = new Map();
    }
    try {
      folderSig = folderSignature(await DB.db.folders.toArray());
    } catch (e) {
      folderSig = '';
    }
  }

  function stopWatch() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    snapshot = null;
    memSnapshot = null;
  }

  /* 备忘录改动（新增 / 勾选 / 修改 / 删除）单独推送，手机端待办列表随即刷新 */
  async function flushMemos() {
    if (!memSnapshot) return 0;
    if (!dc || dc.readyState !== 'open') return 0;
    let memos;
    try { memos = await DB.db.memos.toArray(); } catch (e) { return 0; }
    const next = new Map();
    const changed = [];
    memos.forEach(function (m) {
      next.set(m.id, memoStamp(m));
      const prev = memSnapshot.get(m.id);
      if (prev === undefined || memoStamp(m) > prev) changed.push(m);
    });
    const removed = [];
    memSnapshot.forEach(function (v, id) { if (!next.has(id)) removed.push(id); });
    memSnapshot = next;
    if (!changed.length && !removed.length) return 0;
    if (changed.length) send({ t: 'memo', list: changed });
    if (removed.length) send({ t: 'memo-del', ids: removed });
    return changed.length + removed.length;
  }

  /* 比对数据库与快照，返回本轮新增/修改/删除的 id */
  async function scanChanges() {
    if (!snapshot) return null;
    let docs;
    try { docs = await DB.db.documents.toArray(); } catch (e) { return null; }
    const next = new Map();
    const changed = [];
    const removed = [];
    docs.forEach(function (d) {
      const stamp = d.updatedAt || d.createdAt || 0;
      next.set(d.id, stamp);
      const prev = snapshot.get(d.id);
      if (prev === undefined || stamp > prev) changed.push(d.id);
    });
    snapshot.forEach(function (v, id) { if (!next.has(id)) removed.push(id); });
    snapshot = next;
    return { changed: changed, removed: removed };
  }

  /* 同步期间攒下的变更，本轮结束后补发，否则会被快照吞掉、永久丢失 */
  async function flushPending() {
    if (!pendingPush.size && !pendingRemove.size) return;
    const pushIds = Array.from(pendingPush);
    const removeIds = Array.from(pendingRemove);
    pendingPush.clear();
    pendingRemove.clear();
    try {
      for (let i = 0; i < pushIds.length; i++) await sendOneDoc(pushIds[i]);
      for (let i = 0; i < removeIds.length; i++) send({ t: 'del', id: removeIds[i] });
      emit('live', { count: pushIds.length + removeIds.length });
      emit('progress', {
        stage: '已补发同步期间产生的 ' + (pushIds.length + removeIds.length) + ' 项变更',
        current: 0, total: 0, bytes: stats.bytes
      });
    } catch (e) { /* 连接已断，忽略 */ }
  }

  async function tickWatch() {
    if (!connected || role !== 'desk' || !snapshot) return;

    const memoCount = await flushMemos();
    if (memoCount) {
      emit('memo-push', { count: memoCount });
      emit('progress', { stage: '已同步 ' + memoCount + ' 项待办变更', current: 0, total: 0, bytes: stats.bytes });
    }

    /* 文件夹改名/新建/删除：整份清单推过去，手机端覆盖 */
    try {
      const folders = await DB.db.folders.toArray();
      const sig = folderSignature(folders);
      if (sig !== folderSig) {
        folderSig = sig;
        send({ t: 'folders', list: folders });
        emit('live', { count: 1 });
      }
    } catch (e) { /* 旧库无此表 */ }

    const sc = await scanChanges();
    if (!sc) return;

    /* 全量同步进行中：先记下来，等这轮结束再补发（旧代码直接 return，变更就永久丢了） */
    if (busy) {
      sc.changed.forEach(function (id) { pendingPush.add(id); });
      sc.removed.forEach(function (id) { pendingRemove.add(id); });
      return;
    }

    if (!sc.changed.length && !sc.removed.length) return;

    try {
      for (let i = 0; i < sc.changed.length; i++) await sendOneDoc(sc.changed[i]);
      for (let i = 0; i < sc.removed.length; i++) send({ t: 'del', id: sc.removed[i] });
      emit('live', { count: sc.changed.length + sc.removed.length });
      emit('progress', {
        stage: '已推送 ' + (sc.changed.length + sc.removed.length) + ' 项变更',
        current: 0, total: 0, bytes: stats.bytes
      });
    } catch (e) { /* 连接已断，忽略 */ }
  }

  /* ---------- 工具 ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function sliceString(str, size) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      let end = Math.min(str.length, i + size);
      /* 不切断代理对 */
      if (end < str.length) {
        const code = str.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
      }
      out.push(str.slice(i, end));
      i = end;
    }
    return out;
  }

  window.Sync = {
    on: on,
    state: state,
    createOffer: createOffer,
    acceptOffer: acceptOffer,
    acceptAnswer: acceptAnswer,
    startSync: startSync,
    sendSelected: sendSelected,
    plan: function () { return lastPlan; },
    trimSdp: trimSdp,
    disconnect: disconnect,
    isSupported: function () { return !!(window.RTCPeerConnection && window.RTCPeerConnection.prototype.createDataChannel); }
  };
})();
