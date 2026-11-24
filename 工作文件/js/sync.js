/*
 * 局域网同步（WebRTC 点对点）
 * - 无需服务器、无需账号：两端在同一 WiFi 下直连
 * - 单向为主：电脑（desk）→ 手机（phone），手机新增内容不回传，避免冲突
 * - 增量：按 updatedAt 比对，只传变化的文档本体
 * - 实时：连接保持时监听数据库写入，变更立即推送
 */

(function () {
  const PROTO = 1;
  const CHANNEL = 'workfile-sync';
  const CHUNK = 16 * 1024;            // 单个数据块 16KB
  const MANIFEST_SLICE = 40 * 1024;   // 清单分片大小
  const BUFFER_HIGH = 1024 * 1024;    // 发送缓冲上限 1MB

  let pc = null;
  let dc = null;
  let role = null;            // 'desk'（电脑，数据源）| 'phone'（手机，接收方）
  let connected = false;
  let busy = false;           // 正在同步
  let incoming = {};          // 接收中的文档：id -> { meta, chunks, received, size }
  let manifestParts = [];     // 收到的清单分片
  let manifestTotal = 0;
  let remoteMeta = {};        // 远端文档元信息 id -> meta
  let stats = { sent: 0, recv: 0, bytes: 0, startedAt: 0 };
  let handlers = {};

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
    return { connected: connected, role: role, busy: busy, stats: Object.assign({}, stats) };
  }

  /* ---------- 连接 ---------- */

  function reset() {
    stopWatch();
    try { if (dc) dc.close(); } catch (e) { /* 忽略 */ }
    try { if (pc) pc.close(); } catch (e) { /* 忽略 */ }
    dc = null;
    pc = null;
    connected = false;
    busy = false;
    incoming = {};
    manifestParts = [];
    manifestTotal = 0;
    remoteMeta = {};
    stats = { sent: 0, recv: 0, bytes: 0, startedAt: 0 };
  }

  function waitIce(conn) {
    return new Promise(function (resolve) {
      if (conn.iceGatheringState === 'complete') return resolve();
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, 4000);
      conn.addEventListener('icegatheringstatechange', function () {
        if (conn.iceGatheringState === 'complete') { clearTimeout(timer); finish(); }
      });
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

  function sendHello() {
    send({ t: 'hello', proto: PROTO, role: 'desk', device: '电脑' });
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
    return pc.localDescription.sdp;
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
    return pc.localDescription.sdp;
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
        emit('progress', { stage: '握手完成', current: 0, total: 0, bytes: 0 });
        break;

      case 'manifest-part':
        manifestParts[msg.seq] = msg.data;
        manifestTotal = msg.total;
        break;

      case 'manifest-end':
        onManifest(msg);
        break;

      case 'need':
        sendDocs(msg.ids || []);
        break;

      case 'doc-begin':
        incoming[msg.id] = { meta: msg.meta, size: msg.size, chunks: [], received: 0, total: msg.total };
        break;

      case 'doc-end':
        finishDoc(msg);
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
        busy = false;
        emit('done', { docs: msg.docs || 0, bytes: stats.bytes, from: msg.from || '' });
        emit('state', state());
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

  /* ---------- 电脑端：发清单 ---------- */

  async function startSync() {
    if (!connected || role !== 'desk') throw new Error('请先完成配对');
    if (busy) return { already: true };
    busy = true;
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

    const payload = JSON.stringify({ t: 'manifest', proto: PROTO, docs: metas, series: series, memos: memos, folders: folders });
    const parts = sliceString(payload, MANIFEST_SLICE);
    for (let i = 0; i < parts.length; i++) {
      send({ t: 'manifest-part', seq: i, total: parts.length, data: parts[i] });
      if (i % 10 === 0) await sleep(0);
    }
    send({ t: 'manifest-end', total: parts.length, count: metas.length });
    emit('progress', { stage: '等待手机确认需要哪些文件', current: 0, total: metas.length, bytes: 0 });
  }

  async function sendDocs(ids) {
    if (!ids.length) {
      send({ t: 'done', docs: 0, from: 'desk' });
      busy = false;
      emit('done', { docs: 0, bytes: 0, from: 'desk' });
      emit('state', state());
      return;
    }
    const total = ids.length;
    let doneCount = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const name = await sendOneDoc(id);
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
    busy = false;
    /* 只把已发送的文档记入快照，同步期间新增的仍会被实时推送捕获 */
    await syncSnapshotFor(ids);
    emit('done', { docs: total, bytes: stats.bytes, from: 'desk' });
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
      send({ t: 'doc-meta-only', id: id, meta: stripBlob(doc) });
      return doc.name;
    }
    const buf = await doc.blob.arrayBuffer();
    const total = Math.ceil(buf.byteLength / CHUNK);
    send({ t: 'doc-begin', id: id, size: buf.byteLength, total: total, meta: stripBlob(doc) });
    for (let i = 0; i < total; i++) {
      await waitBuffer();
      const piece = buf.slice(i * CHUNK, Math.min(buf.byteLength, (i + 1) * CHUNK));
      const frame = new ArrayBuffer(8 + piece.byteLength);
      const dv = new DataView(frame);
      dv.setUint32(0, id, true);
      dv.setUint32(4, i, true);
      new Uint8Array(frame, 8).set(new Uint8Array(piece));
      dc.send(frame);
      stats.sent++;
      stats.bytes += piece.byteLength;
    }
    send({ t: 'doc-end', id: id });
    return doc.name;
  }

  function waitBuffer() {
    return new Promise(function (resolve) {
      if (!dc || dc.readyState !== 'open') return resolve();
      if (dc.bufferedAmount < BUFFER_HIGH) return resolve();
      const onLow = function () {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      dc.bufferedAmountLowThreshold = BUFFER_HIGH / 2;
      dc.addEventListener('bufferedamountlow', onLow);
      setTimeout(function () {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      }, 4000);
    });
  }

  function stripBlob(doc) {
    const c = {};
    Object.keys(doc).forEach(function (k) { if (k !== 'blob') c[k] = doc[k]; });
    return c;
  }

  /* ---------- 手机端：收清单、要文件、落库 ---------- */

  async function onManifest(msg) {
    const json = manifestParts.join('');
    manifestParts = [];
    let mf;
    try { mf = JSON.parse(json); } catch (e) {
      emit('error', { message: '清单解析失败，请重新配对' });
      return;
    }
    const docs = mf.docs || [];
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

    /* 无本体的记录类：直接写入 */
    for (let i = 0; i < metaOnly.length; i++) {
      const d = Object.assign({}, metaOnly[i]);
      delete d.hasBlob;
      const local = byId[d.id] || byOrigin[d.id];
      if (local) d.id = local.id;
      else if (byId[d.id]) { d.originId = d.id; delete d.id; }
      try { await DB.db.documents.put(d); } catch (e) { /* 跳过 */ }
    }
    if (metaOnly.length) emit('remote-doc', { count: metaOnly.length });

    emit('progress', { stage: '需要接收 ' + need.length + ' 份文件', current: 0, total: need.length, bytes: 0 });
    send({ t: 'need', ids: need });
    if (!need.length) {
      busy = false;
      emit('done', { docs: 0, bytes: 0, from: 'phone' });
    }
  }

  async function finishDoc(msg) {
    const box = incoming[msg.id];
    if (!box) return;
    delete incoming[msg.id];
    if (msg.missing || !box.meta) return;

    const meta = Object.assign({}, box.meta);
    delete meta.hasBlob;
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

  async function tickWatch() {
    if (!connected || role !== 'desk' || !snapshot) return;
    if (busy) return;   /* 全量同步进行中先不插队 */

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

    let docs;
    try { docs = await DB.db.documents.toArray(); } catch (e) { return; }

    const next = new Map();
    const changed = [];
    docs.forEach(function (d) {
      const stamp = d.updatedAt || d.createdAt || 0;
      next.set(d.id, stamp);
      const prev = snapshot.get(d.id);
      if (prev === undefined || stamp > prev) changed.push(d.id);
    });
    const removed = [];
    snapshot.forEach(function (v, id) { if (!next.has(id)) removed.push(id); });
    snapshot = next;
    if (!changed.length && !removed.length) return;

    try {
      for (let i = 0; i < changed.length; i++) await sendOneDoc(changed[i]);
      for (let i = 0; i < removed.length; i++) send({ t: 'del', id: removed[i] });
      emit('live', { count: changed.length + removed.length });
      emit('progress', {
        stage: '已推送 ' + (changed.length + removed.length) + ' 项变更',
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
    disconnect: disconnect,
    isSupported: function () { return !!(window.RTCPeerConnection && window.RTCPeerConnection.prototype.createDataChannel); }
  };
})();
