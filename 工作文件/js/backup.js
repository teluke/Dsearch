/* 备份导出与恢复导入 */

(function () {
  const BACKUP_VERSION = 1;

  function stamp() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stripBlob(doc) {
    const copy = {};
    Object.keys(doc).forEach(function (k) {
      if (k !== 'blob') copy[k] = doc[k];
    });
    return copy;
  }

  async function exportBackup(onProgress) {
    const docs = await DB.allDocuments();
    const series = await DB.listSeries();
    const settings = await DB.allSettings();
    let viewLogs = [];
    try { viewLogs = await DB.db.viewLogs.toArray(); } catch (e) { /* 旧库无此表 */ }
    let memos = [];
    try { memos = await DB.db.memos.toArray(); } catch (e) { /* 旧库无此表 */ }
    let folders = [];
    try { folders = await DB.db.folders.toArray(); } catch (e) { /* 旧库无此表 */ }

    const zip = new JSZip();
    const files = zip.folder('files');

    const records = docs.map(function (d) {
      const meta = stripBlob(d);
      meta.blobFile = 'files/' + d.id + '.' + (d.ext || 'bin');
      return meta;
    });

    zip.file('data.json', JSON.stringify({
      app: '工作文件',
      version: BACKUP_VERSION,
      schema: 1,
      exportedAt: new Date().toISOString(),
      documents: records,
      series: series,
      settings: settings,
      viewLogs: viewLogs,
      memos: memos,
      folders: folders
    }, null, 2));

    let done = 0;
    docs.forEach(function (d) {
      if (d.blob) {
        files.file(d.id + '.' + (d.ext || 'bin'), d.blob);
      }
      done++;
      if (onProgress) onProgress(Math.round(done / Math.max(1, docs.length) * 45), '正在打包文件 ' + done + '/' + docs.length);
    });

    const manifest = {
      app: '工作文件',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      documentCount: docs.length,
      seriesCount: series.length,
      fileCount: docs.filter(function (d) { return !!d.blob; }).length
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    /* PRD 4.4：导出完成后校验「记录数 = files 目录文件数」，不一致则判定失败 */
    const packedEntries = Object.keys(zip.files).filter(function (n) {
      return /^files\//.test(n) && !zip.files[n].dir;
    }).length;
    if (packedEntries !== docs.length) {
      throw new Error('备份校验失败：记录数 ' + docs.length + ' 与文件数 ' + packedEntries + ' 不一致，未生成备份');
    }

    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } },
      function (meta) {
        if (onProgress) onProgress(45 + Math.round(meta.percent * 0.55), '正在压缩 ' + Math.round(meta.percent) + '%');
      }
    );

    const name = '工作文件-备份-' + stamp() + '.zip';
    downloadBlob(blob, name);

    return { name: name, count: docs.length, size: blob.size, manifest: manifest };
  }

  async function readBackup(file, onProgress) {
    if (!window.JSZip) throw new Error('备份组件未加载');
    const zip = await JSZip.loadAsync(file);

    const manifestEntry = zip.file('manifest.json');
    const dataEntry = zip.file('data.json');
    if (!dataEntry) throw new Error('备份文件缺少 data.json');

    if (manifestEntry) {
      const manifest = JSON.parse(await manifestEntry.async('string'));
      if (manifest.version && manifest.version > BACKUP_VERSION) {
        throw new Error('备份文件版本较新，当前应用无法读取');
      }
    }

    const data = JSON.parse(await dataEntry.async('string'));
    if (!data || !Array.isArray(data.documents)) throw new Error('备份数据结构不正确');

    const docs = [];
    const total = data.documents.length;
    for (let i = 0; i < total; i++) {
      const meta = data.documents[i];
      let blob = null;
      const path = meta.blobFile || ('files/' + meta.id + '.' + (meta.ext || 'bin'));
      const entry = zip.file(path);
      if (entry) blob = await entry.async('blob');
      const doc = stripBlob(meta);
      delete doc.blobFile;
      doc.blob = blob;
      if (!doc.size && blob) doc.size = blob.size;
      docs.push(doc);
      if (onProgress) onProgress(Math.round((i + 1) / Math.max(1, total) * 80), '正在读取 ' + (i + 1) + '/' + total);
    }

    return {
      version: data.version || 1,
      documents: docs,
      series: Array.isArray(data.series) ? data.series : [],
      settings: Array.isArray(data.settings) ? data.settings : [],
      viewLogs: Array.isArray(data.viewLogs) ? data.viewLogs : [],
      memos: Array.isArray(data.memos) ? data.memos : [],
      folders: Array.isArray(data.folders) ? data.folders : [],
      exportedAt: data.exportedAt || ''
    };
  }

  async function applyBackup(payload, mode) {
    const docs = payload.documents || [];
    const series = payload.series || [];
    const settings = payload.settings || [];
    const viewLogs = payload.viewLogs || [];
    const memos = payload.memos || [];
    const folders = payload.folders || [];

    await DB.db.transaction('rw', DB.db.documents, DB.db.series, DB.db.settings, DB.db.viewLogs, DB.db.memos, DB.db.folders, async function () {
      if (mode === 'replace') {
        await DB.db.documents.clear();
        await DB.db.series.clear();
        await DB.db.settings.clear();
        await DB.db.viewLogs.clear();
        await DB.db.memos.clear();
        await DB.db.folders.clear();
      }
      if (folders.length) await DB.db.folders.bulkPut(folders);
      if (docs.length) await DB.db.documents.bulkPut(docs);
      if (series.length) await DB.db.series.bulkPut(series);
      if (settings.length) await DB.db.settings.bulkPut(settings);
      if (viewLogs.length) await DB.db.viewLogs.bulkPut(viewLogs);
      if (memos.length) await DB.db.memos.bulkPut(memos);
    });

    return { documents: docs.length, series: series.length };
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCsv(headers, rows, filename) {
    const lines = [];
    lines.push(headers.map(csvCell).join(','));
    rows.forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    const text = '\ufeff' + lines.join('\r\n');
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, filename);
  }

  window.Backup = {
    exportBackup: exportBackup,
    readBackup: readBackup,
    applyBackup: applyBackup,
    downloadBlob: downloadBlob,
    exportCsv: exportCsv
  };
})();
