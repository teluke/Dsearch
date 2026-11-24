/*
 * 图片文字识别任务队列
 * 负责：把归档的图片排进识别队列、串行执行、把识别文本写回记录、提供统计与清理。
 * 识别在本机完成（见 ocr.js），不产生任何网络上传。
 */

(function () {
  const MAX_OCR_TEXT = 120000;
  const MAX_ERR = 120;

  const queue = [];
  let running = false;
  let settings = { enabled: true, cnOnly: false, loaded: false };
  const listeners = [];
  let lastRefresh = 0;

  /* ---------- 设置 ---------- */

  async function loadSettings(force) {
    if (settings.loaded && !force) return settings;
    try {
      settings.enabled = (await DB.getSetting('ocrEnabled', true)) !== false;
      settings.cnOnly = (await DB.getSetting('ocrCnOnly', false)) === true;
    } catch (e) { /* 读不到就用默认 */ }
    settings.loaded = true;
    window.OCRSettings = { cnOnly: settings.cnOnly };
    return settings;
  }

  function getSettings() { return settings; }

  async function setSettings(patch) {
    if (patch.enabled != null) {
      settings.enabled = !!patch.enabled;
      await DB.setSetting('ocrEnabled', settings.enabled);
    }
    if (patch.cnOnly != null) {
      settings.cnOnly = !!patch.cnOnly;
      await DB.setSetting('ocrCnOnly', settings.cnOnly);
      window.OCRSettings = { cnOnly: settings.cnOnly };
      /* 语言模型换了，旧引擎实例作废 */
      OCR.release();
    }
    return settings;
  }

  /* ---------- 事件 ---------- */

  function on(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function emit(evt) {
    listeners.forEach(function (fn) {
      try { fn(evt); } catch (e) { /* 单个订阅出错不影响其他 */ }
    });
  }

  /* 识别完成后节流刷新界面，避免连续多张时反复整页重绘 */
  function scheduleRefresh() {
    const now = Date.now();
    if (now - lastRefresh < 900) return;
    lastRefresh = now;
    if (window.App && window.App.refresh) window.App.refresh();
  }

  /* ---------- 队列 ---------- */

  function pending() { return queue.length + (running ? 1 : 0); }

  function enqueue(docId, opts) {
    if (!docId) return;
    if (queue.some(function (j) { return j.docId === docId; })) return;
    queue.push({ docId: docId, force: !!(opts && opts.force) });
    emit({ type: 'queued', docId: docId, pending: pending() });
    pump();
  }

  function enqueueMany(ids) {
    (ids || []).forEach(function (id) { enqueue(id); });
  }

  async function runDoc(id) {
    const doc = await DB.getDocument(id);
    if (!doc || !doc.blob) return null;
    if (Parser.kindOf(doc.name || '') !== 'image') return null;

    emit({ type: 'start', docId: id, name: doc.name, pending: pending() });
    scheduleRefresh();
    await DB.updateDocument(id, { ocrStatus: 'pending' });

    try {
      const res = await OCR.recognize(doc.blob, {
        docId: id,
        name: doc.name,
        onProgress: function (stage, p) {
          emit({ type: 'progress', docId: id, stage: stage, p: p, pending: pending() });
        }
      });

      if (!res.text) {
        await DB.updateDocument(id, { ocrText: '', ocrStatus: 'empty', ocrAt: Date.now(), ocrChars: 0 });
        emit({ type: 'done', docId: id, empty: true, pending: pending() });
        return { empty: true };
      }

      const text = res.text.slice(0, MAX_OCR_TEXT);
      await DB.updateDocument(id, {
        ocrText: text,
        ocrStatus: 'done',
        ocrAt: Date.now(),
        ocrConf: res.confidence,
        ocrChars: text.length
      });
      emit({ type: 'done', docId: id, chars: text.length, confidence: res.confidence, pending: pending() });
      return { chars: text.length };
    } catch (err) {
      const msg = ((err && err.message) || '识别失败').slice(0, MAX_ERR);
      await DB.updateDocument(id, { ocrStatus: 'failed', ocrErr: msg, ocrAt: Date.now() });
      emit({ type: 'error', docId: id, message: msg, pending: pending() });
      return { error: msg };
    }
  }

  async function pump() {
    if (running) return;
    let doneCount = 0;
    while (queue.length) {
      const job = queue.shift();
      running = true;
      try {
        const r = await runDoc(job.docId);
        if (r && r.chars) doneCount++;
      } catch (e) {
        console.warn('[识别队列] 任务异常', e);
      }
      running = false;
      scheduleRefresh();
      emit({ type: 'tick', pending: pending() });
    }
    if (doneCount > 0 && window.UI) {
      UI.toast('图片文字识别完成，共 ' + doneCount + ' 张，已可被搜索', 'ok');
    }
    emit({ type: 'idle', pending: 0 });
  }

  /* 上次会话被中断的识别（页面刷新、关掉浏览器）：状态停在 pending，重新排队补完。
     只补 pending，不动从未识别过的历史图片，避免升级后一次性跑几十张。 */
  async function resumePending() {
    const st = await loadSettings();
    if (!st.enabled) return 0;
    const rows = await DB.allDocuments();
    const ids = rows.filter(function (d) {
      return d.ocrStatus === 'pending' && d.blob && Parser.kindOf(d.name || '') === 'image';
    }).map(function (d) { return d.id; });
    ids.forEach(function (id) { enqueue(id); });
    return ids.length;
  }

  /* 单份立即识别（查看器里的按钮），返回识别结果文本 */
  async function recognizeDoc(doc) {
    if (!doc || !doc.blob) throw new Error('没有可识别的图片');
    await loadSettings();
    emit({ type: 'start', docId: doc.id, name: doc.name, pending: pending() });
    const res = await OCR.recognize(doc.blob, {
      docId: doc.id,
      name: doc.name,
      onProgress: function (stage, p) {
        emit({ type: 'progress', docId: doc.id, stage: stage, p: p, pending: pending() });
      }
    });
    const text = (res.text || '').slice(0, MAX_OCR_TEXT);
    await DB.updateDocument(doc.id, {
      ocrText: text,
      ocrStatus: text ? 'done' : 'empty',
      ocrAt: Date.now(),
      ocrConf: res.confidence || 0,
      ocrChars: text.length
    });
    doc.ocrText = text;
    doc.ocrStatus = text ? 'done' : 'empty';
    doc.ocrConf = res.confidence || 0;
    emit({ type: 'done', docId: doc.id, chars: text.length, confidence: res.confidence });
    return { text: text, confidence: res.confidence || 0, ms: res.ms };
  }

  /* ---------- 统计与清理 ---------- */

  async function stats() {
    const rows = await DB.allDocuments();
    const out = { total: 0, done: 0, empty: 0, failed: 0, pending: 0, none: 0, chars: 0 };
    rows.forEach(function (d) {
      if (Parser.kindOf(d.name || '') !== 'image') return;
      out.total++;
      const st = d.ocrStatus || 'none';
      if (st === 'done') { out.done++; out.chars += (d.ocrText || '').length; }
      else if (st === 'empty') out.empty++;
      else if (st === 'failed') out.failed++;
      else if (st === 'pending') out.pending++;
      else out.none++;
    });
    return out;
  }

  /* 重新识别所有图片（已有文本也会覆盖） */
  async function reindexAll() {
    const rows = await DB.allDocuments();
    const ids = rows.filter(function (d) {
      return Parser.kindOf(d.name || '') === 'image' && d.blob;
    }).map(function (d) { return d.id; });
    ids.forEach(function (id) { enqueue(id, { force: true }); });
    return ids.length;
  }

  async function clearText(docId) {
    await DB.updateDocument(docId, { ocrText: '', ocrStatus: 'cleared', ocrChars: 0 });
    const doc = await DB.getDocument(docId);
    if (doc) { doc.ocrText = ''; doc.ocrStatus = 'cleared'; }
  }

  async function clearAll() {
    const rows = await DB.allDocuments();
    let n = 0;
    for (const d of rows) {
      if (!d.ocrText) continue;
      await DB.updateDocument(d.id, { ocrText: '', ocrStatus: 'cleared', ocrChars: 0 });
      n++;
    }
    return n;
  }

  window.OCRJob = {
    loadSettings: loadSettings,
    getSettings: getSettings,
    setSettings: setSettings,
    enqueue: enqueue,
    enqueueMany: enqueueMany,
    resumePending: resumePending,
    recognizeDoc: recognizeDoc,
    pending: pending,
    stats: stats,
    reindexAll: reindexAll,
    clearText: clearText,
    clearAll: clearAll,
    on: on
  };
})();
