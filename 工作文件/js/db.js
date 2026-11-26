/* 数据层：IndexedDB（Dexie） */

(function () {
  const DB_NAME = 'gongzuowenjian';
  const db = new Dexie(DB_NAME);

  db.version(2).stores({
    documents: '++id, name, ext, seriesId, archiveDate, fileDate, createdAt, updatedAt',
    series: '++id, name, createdAt',
    settings: 'key',
    viewLogs: '++id, docId, viewedAt'
  });

  /* v3：新增备忘录表（快速待办） */
  db.version(3).stores({
    documents: '++id, name, ext, seriesId, archiveDate, fileDate, createdAt, updatedAt',
    series: '++id, name, createdAt',
    settings: 'key',
    viewLogs: '++id, docId, viewedAt',
    memos: '++id, date, done, createdAt'
  });

  /* v4：新增文件夹表（归档整理用，与「系列」区分：系列管字段统计，文件夹管摆放） */
  db.version(4).stores({
    documents: '++id, name, ext, seriesId, folderId, archiveDate, fileDate, createdAt, updatedAt',
    series: '++id, name, createdAt',
    settings: 'key',
    viewLogs: '++id, docId, viewedAt',
    memos: '++id, date, done, createdAt',
    folders: '++id, name, createdAt'
  });

  /* v5：文件夹支持子文件夹（parentId 层级） */
  db.version(5).stores({
    documents: '++id, name, ext, seriesId, folderId, archiveDate, fileDate, createdAt, updatedAt',
    series: '++id, name, createdAt',
    settings: 'key',
    viewLogs: '++id, docId, viewedAt',
    memos: '++id, date, done, createdAt',
    folders: '++id, name, parentId, createdAt'
  });

  const VIEWLOG_KEEP = 500;

  const SCHEMA_VERSION = 1;

  const DOC_EXTS = ['doc', 'docx', 'rtf', 'wps'];
  const SHEET_EXTS = ['xls', 'xlsx', 'csv'];
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'];

  /* 扩展名 → 类型（doc / sheet / pdf / image / other），供类型筛选使用 */
  function kindOfExt(ext) {
    const e = String(ext || '').toLowerCase();
    if (DOC_EXTS.indexOf(e) >= 0) return 'doc';
    if (SHEET_EXTS.indexOf(e) >= 0) return 'sheet';
    if (e === 'pdf') return 'pdf';
    if (IMAGE_EXTS.indexOf(e) >= 0) return 'image';
    return 'other';
  }

  /* 排序口径：按文件名日期时，无日期的文件降级用归档日期 */
  function sortDateOf(d, sortKey) {
    return sortKey === 'fileDate' ? (d.fileDate || d.archiveDate || '') : (d.archiveDate || '');
  }

  /* 同一日期下：同名文件按文件属性时间新→旧（新文件在前）；带序号的按序号大→小 */
  function compareDocs(a, b, sortKey) {
    const av = sortDateOf(a, sortKey || 'archiveDate');
    const bv = sortDateOf(b, sortKey || 'archiveDate');
    if (av !== bv) return av < bv ? 1 : -1;

    const keyOf = window.Parser && window.Parser.nameKey
      ? window.Parser.nameKey
      : function (n) { return String(n || '').toLowerCase(); };
    const an = keyOf(a.name);
    const bn = keyOf(b.name);
    if (an && an === bn) {
      const as = a.seq == null ? -1 : a.seq;
      const bs = b.seq == null ? -1 : b.seq;
      if (as !== bs) return bs - as;
      const at = a.fileModified || 0;
      const bt = b.fileModified || 0;
      if (at !== bt) return bt - at;
    }
    return (b.createdAt || 0) - (a.createdAt || 0);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function toISO(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function todayISO() { return toISO(new Date()); }

  class QuotaError extends Error {
    constructor(message) {
      super(message || '存储空间不足');
      this.name = 'QuotaError';
    }
  }

  async function storageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0 };
      } catch (e) { /* 忽略 */ }
    }
    return { usage: 0, quota: 0 };
  }

  async function assertSpace(bytes) {
    const { usage, quota } = await storageEstimate();
    if (quota > 0 && usage + bytes > quota * 0.995) {
      throw new QuotaError('存储空间不足，请先清理或导出备份');
    }
  }

  async function addDocument(doc) {
    await assertSpace(doc.size || 0);
    const now = Date.now();
    const payload = Object.assign({
      name: '', ext: '', mime: '', size: 0,
      archiveDate: todayISO(), fileDate: '', dateSource: 'manual',
      seriesId: null, folderId: null, fields: {}, note: '', fullText: '',
      /* 文件名序号 + 文件属性里的修改时间（同名文件排序用） */
      seq: null, seqTag: '', fileModified: 0,
      extractStatus: 'pending', blob: null,
      /* 图片文字识别：ocrText 参与全文检索，其余是状态与来源标记 */
      ocrText: '', ocrStatus: 'none', ocrAt: 0, ocrConf: 0, ocrChars: 0,
      createdAt: now, updatedAt: now
    }, doc);
    payload.createdAt = now;
    payload.updatedAt = now;
    const id = await db.documents.add(payload);
    return id;
  }

  async function updateDocument(id, patch) {
    const data = Object.assign({}, patch, { updatedAt: Date.now() });
    await db.documents.update(id, data);
    return db.documents.get(id);
  }

  async function getDocument(id) {
    return db.documents.get(id);
  }

  async function deleteDocument(id) {
    await db.viewLogs.where('docId').equals(id).delete();
    return db.documents.delete(id);
  }

  async function deleteMany(ids) {
    if (!ids || !ids.length) return 0;
    await db.viewLogs.where('docId').anyOf(ids).delete();
    await db.documents.bulkDelete(ids);
    return ids.length;
  }

  async function clearDocuments() {
    await db.documents.clear();
    await db.viewLogs.clear();
  }

  async function allDocuments() {
    return db.documents.toArray();
  }

  async function listDocuments(opts) {
    opts = opts || {};
    const sortKey = opts.sort === 'fileDate' ? 'fileDate' : 'archiveDate';
    let rows = await db.documents.toArray();
    if (opts.seriesId) rows = rows.filter(d => d.seriesId === opts.seriesId);
    if (opts.ext) rows = rows.filter(d => kindOfExt(d.ext) === opts.ext);
    if (opts.month && opts.month !== 'all') {
      rows = rows.filter(d => sortDateOf(d, sortKey).slice(0, 7) === opts.month);
    }
    rows.sort((a, b) => compareDocs(a, b, sortKey));
    return rows;
  }

  function summaryOf(text, keyword) {
    if (!text) return '';
    const lower = text.toLowerCase();
    const idx = lower.indexOf(keyword.toLowerCase());
    if (idx < 0) return text.slice(0, 46).replace(/\s+/g, ' ');
    const start = Math.max(0, idx - 18);
    const end = Math.min(text.length, idx + keyword.length + 28);
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  }

  async function searchDocuments(opts) {
    const q = (opts.q || '').trim();
    const kw = q.toLowerCase();
    let rows = await db.documents.toArray();
    if (opts.seriesId) rows = rows.filter(d => d.seriesId === opts.seriesId);
    if (opts.ext) rows = rows.filter(d => kindOfExt(d.ext) === opts.ext);

    const results = [];
    rows.forEach(d => {
      const fieldText = Object.keys(d.fields || {}).map(k => String(d.fields[k] == null ? '' : d.fields[k])).join(' ');
      const inName = (d.name || '').toLowerCase().indexOf(kw) >= 0;
      const inFields = fieldText.toLowerCase().indexOf(kw) >= 0;
      const inText = (d.fullText || '').toLowerCase().indexOf(kw) >= 0;
      const inOcr = (d.ocrText || '').toLowerCase().indexOf(kw) >= 0;
      if (!kw || inName || inFields || inText || inOcr) {
        const hit = inText ? 'text' : (inOcr ? 'ocr' : (inFields ? 'fields' : (inName ? 'name' : 'all')));
        const snippet = inText ? summaryOf(d.fullText, q)
          : (inOcr ? summaryOf(d.ocrText, q)
            : (inFields ? summaryOf(fieldText, q) : ''));
        results.push({ doc: d, hit: hit, snippet: snippet });
      }
    });

    results.sort((a, b) => compareDocs(a.doc, b.doc, 'fileDate'));
    return results;
  }

  async function documentsBySeries() {
    const rows = await db.documents.toArray();
    const map = {};
    rows.forEach(d => {
      if (!d.seriesId) return;
      map[d.seriesId] = (map[d.seriesId] || 0) + 1;
    });
    return map;
  }

  async function listSeries() {
    const rows = await db.series.toArray();
    rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return rows;
  }

  async function addSeries(series) {
    const now = Date.now();
    const payload = Object.assign({ name: '', fields: [], createdAt: now, updatedAt: now }, series);
    payload.createdAt = now;
    payload.updatedAt = now;
    return db.series.add(payload);
  }

  async function updateSeries(id, patch) {
    await db.series.update(id, Object.assign({}, patch, { updatedAt: Date.now() }));
    return db.series.get(id);
  }

  async function deleteSeries(id) {
    await db.series.delete(id);
    const docs = await db.documents.where('seriesId').equals(id).toArray();
    if (docs.length) {
      for (const d of docs) {
        await db.documents.update(d.id, { seriesId: null, updatedAt: Date.now() });
      }
    }
  }

  async function seriesUsage(id) {
    return db.documents.where('seriesId').equals(id).count();
  }

  /* ---------- 文件夹（归档整理） ---------- */

  async function listFolders() {
    const rows = await db.folders.toArray();
    rows.sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name, 'zh');
    });
    return rows;
  }

  async function addFolder(name, parentId) {
    const now = Date.now();
    const clean = String(name || '').trim();
    if (!clean) throw new Error('文件夹名称不能为空');
    const pid = parentId == null ? null : parseInt(parentId, 10);
    if (pid != null) {
      const parent = await db.folders.get(pid);
      if (!parent) throw new Error('上级文件夹不存在');
    }
    return db.folders.add({ name: clean, parentId: pid, createdAt: now, updatedAt: now });
  }

  async function updateFolder(id, patch) {
    await db.folders.update(id, Object.assign({}, patch, { updatedAt: Date.now() }));
    return db.folders.get(id);
  }

  /* 是否是 target 的后代（含自身）：移动文件夹时防止把自己挂到子孙下面形成环 */
  function isDescendantRow(rows, id, targetId) {
    if (id === targetId) return true;
    const kids = rows.filter(function (r) { return (r.parentId || null) === id && r.id !== id; });
    for (let i = 0; i < kids.length; i++) {
      if (isDescendantRow(rows, kids[i].id, targetId)) return true;
    }
    return false;
  }

  /* 移动文件夹：newParentId 为 null 表示移到顶层 */
  async function moveFolder(id, newParentId) {
    const pid = newParentId == null ? null : parseInt(newParentId, 10);
    const rows = await db.folders.toArray();
    const me = rows.filter(function (r) { return r.id === id; })[0];
    if (!me) throw new Error('文件夹不存在');
    if (pid === (me.parentId || null)) return me; /* 位置没变 */
    if (pid != null) {
      const parent = rows.filter(function (r) { return r.id === pid; })[0];
      if (!parent) throw new Error('目标文件夹不存在');
      if (isDescendantRow(rows, id, pid)) throw new Error('不能移动到自己的子文件夹里');
    }
    await db.folders.update(id, { parentId: pid, updatedAt: Date.now() });
    return db.folders.get(id);
  }

  /* 删除文件夹：子文件夹上移一级接替位置，里面的文件退回「未归类」，不删文件 */
  async function deleteFolder(id) {
    const me = await db.folders.get(id);
    const pid = me ? (me.parentId || null) : null;
    await db.folders.delete(id);
    const kids = await db.folders.where('parentId').equals(id).toArray();
    for (const k of kids) {
      await db.folders.update(k.id, { parentId: pid, updatedAt: Date.now() });
    }
    const docs = await db.documents.where('folderId').equals(id).toArray();
    for (const d of docs) {
      await db.documents.update(d.id, { folderId: null, updatedAt: Date.now() });
    }
    return docs.length;
  }

  async function folderUsage(id) {
    return db.documents.where('folderId').equals(id).count();
  }

  async function getSetting(key, fallback) {
    const row = await db.settings.get(key);
    return row ? row.value : fallback;
  }

  async function setSetting(key, value) {
    await db.settings.put({ key: key, value: value });
  }

  /* 多个设置一次事务写完，省掉多次 IndexedDB 往返 */
  async function setSettings(map) {
    const rows = Object.keys(map || {}).map(function (k) { return { key: k, value: map[k] }; });
    if (rows.length) await db.settings.bulkPut(rows);
  }

  async function allSettings() {
    return db.settings.toArray();
  }

  async function storageInfo() {
    const rows = await db.documents.toArray();
    const byType = { doc: 0, sheet: 0, pdf: 0, image: 0, other: 0 };
    let totalBytes = 0;
    rows.forEach(d => {
      const size = d.size || 0;
      totalBytes += size;
      const ext = (d.ext || '').toLowerCase();
      if (ext === 'doc' || ext === 'docx') byType.doc += size;
      else if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') byType.sheet += size;
      else if (ext === 'pdf') byType.pdf += size;
      else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].indexOf(ext) >= 0) byType.image += size;
      else byType.other += size;
    });
    const est = await storageEstimate();
    return {
      count: rows.length,
      totalBytes: totalBytes,
      byType: byType,
      usage: est.usage,
      quota: est.quota,
      ratio: est.quota > 0 ? est.usage / est.quota : 0
    };
  }

  async function initSettings() {
    const v = await getSetting('schemaVersion', null);
    if (v == null) {
      await setSetting('schemaVersion', SCHEMA_VERSION);
      await setSetting('createdAt', Date.now());
    }
  }

  /* ---------- 查看记录 ---------- */

  async function addViewLog(entry) {
    const payload = Object.assign({ docId: null, name: '', ext: '', viewedAt: Date.now() }, entry);
    const id = await db.viewLogs.add(payload);
    /* 只保留最近 500 条，避免无限增长 */
    const count = await db.viewLogs.count();
    if (count > VIEWLOG_KEEP) {
      const stale = await db.viewLogs.orderBy('viewedAt').limit(count - VIEWLOG_KEEP).primaryKeys();
      await db.viewLogs.bulkDelete(stale);
    }
    return id;
  }

  async function listViewLogs(limit) {
    const rows = await db.viewLogs.orderBy('viewedAt').reverse().limit(limit || 100).toArray();
    return rows;
  }

  async function countViewLogs() {
    return db.viewLogs.count();
  }

  async function clearViewLogs() {
    return db.viewLogs.clear();
  }

  /* ---------- 备忘录（快速待办） ---------- */

  async function addMemo(memo) {
    const now = Date.now();
    return db.memos.add(Object.assign({
      text: '', date: todayISO(), done: false, createdAt: now, updatedAt: now
    }, memo, { createdAt: now, updatedAt: now }));
  }

  async function listMemos() {
    const rows = await db.memos.toArray();
    /* 未完成在前（按日期早→晚），已完成在后（新→旧） */
    rows.sort(function (a, b) {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      if (a.date !== b.date) return (a.date || '') < (b.date || '') ? -1 : 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return rows;
  }

  async function updateMemo(id, patch) {
    /* updatedAt 让局域网实时推送能识别出「这条备忘变了」 */
    await db.memos.update(id, Object.assign({ updatedAt: Date.now() }, patch));
    return db.memos.get(id);
  }

  async function deleteMemo(id) {
    return db.memos.delete(id);
  }

  async function clearMemos() {
    return db.memos.clear();
  }

  window.DB = {
    db: db,
    QuotaError: QuotaError,
    todayISO: todayISO,
    toISO: toISO,
    addDocument: addDocument,
    updateDocument: updateDocument,
    getDocument: getDocument,
    deleteDocument: deleteDocument,
    deleteMany: deleteMany,
    clearDocuments: clearDocuments,
    allDocuments: allDocuments,
    listDocuments: listDocuments,
    searchDocuments: searchDocuments,
    compareDocs: compareDocs,
    documentsBySeries: documentsBySeries,
    listSeries: listSeries,
    addSeries: addSeries,
    updateSeries: updateSeries,
    deleteSeries: deleteSeries,
    seriesUsage: seriesUsage,
    listFolders: listFolders,
    addFolder: addFolder,
    updateFolder: updateFolder,
    moveFolder: moveFolder,
    deleteFolder: deleteFolder,
    folderUsage: folderUsage,
    getSetting: getSetting,
    setSetting: setSetting,
    setSettings: setSettings,
    allSettings: allSettings,
    storageInfo: storageInfo,
    storageEstimate: storageEstimate,
    assertSpace: assertSpace,
    initSettings: initSettings,
    addViewLog: addViewLog,
    listViewLogs: listViewLogs,
    countViewLogs: countViewLogs,
    clearViewLogs: clearViewLogs,
    addMemo: addMemo,
    listMemos: listMemos,
    updateMemo: updateMemo,
    deleteMemo: deleteMemo,
    clearMemos: clearMemos
  };
})();
