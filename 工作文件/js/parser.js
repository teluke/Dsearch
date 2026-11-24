/* 内容解析：文件名日期识别、文档全文提取 */

(function () {
  const MAX_TEXT = 200000;

  const DOC_EXT = ['doc', 'docx', 'rtf', 'wps'];
  const SHEET_EXT = ['xls', 'xlsx', 'csv'];
  const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'];
  const TEXT_EXT = ['txt', 'md', 'log'];

  function pad(n) { return String(n).padStart(2, '0'); }

  function extOf(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function kindOf(name) {
    const ext = extOf(name);
    if (DOC_EXT.indexOf(ext) >= 0) return 'doc';
    if (SHEET_EXT.indexOf(ext) >= 0) return 'sheet';
    if (ext === 'pdf') return 'pdf';
    if (IMAGE_EXT.indexOf(ext) >= 0) return 'image';
    return 'other';
  }

  function buildDate(y, mo, d) {
    y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
    if (!y || !mo || !d) return null;
    if (y < 1990 || y > 2100) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { date: y + '-' + pad(mo) + '-' + pad(d), source: 'name' };
  }

  function parseDateFromName(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');

    let m = base.match(/(20\d{2})\s*[-.\/年]\s*(\d{1,2})\s*[-.\/月]\s*(\d{1,2})\s*日?/);
    if (m) {
      const r = buildDate(m[1], m[2], m[3]);
      if (r) return r;
    }

    m = base.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
    if (m) {
      const r = buildDate(m[1], m[2], m[3]);
      if (r) return r;
    }

    m = base.match(/(^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      const r = buildDate(new Date().getFullYear(), m[2], m[3]);
      if (r) return r;
    }

    m = base.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
    if (m) {
      const r = buildDate(m[1], m[2], 1);
      if (r) return r;
    }

    return null;
  }

  /* ---------- 文件名序号 ---------- */

  /* 中文数字 → 阿拉伯数字（「三」「二十三」「一百零三」） */
  const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  function cnNumber(str) {
    const s = String(str || '');
    if (/^\d{1,4}$/.test(s)) return parseInt(s, 10);
    let total = 0;
    let cur = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (CN_DIGIT[ch] != null) {
        cur = CN_DIGIT[ch];
      } else if (ch === '十') {
        total += (cur || 1) * 10;
        cur = 0;
      } else if (ch === '百') {
        total += (cur || 1) * 100;
        cur = 0;
      } else {
        return null;
      }
    }
    return total + cur;
  }

  /* 序号常与日期混在一起（2026-03-05-第2次），先把日期片段抹掉再找序号 */
  const DATE_PATTERNS = [
    /20\d{2}\s*[-.\/年]\s*\d{1,2}\s*[-.\/月]\s*\d{1,2}\s*日?/g,
    /20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /20\d{2}\s*年\s*\d{1,2}\s*月/g
  ];

  function stripDates(base) {
    let s = String(base || '');
    DATE_PATTERNS.forEach(function (re) { s = s.replace(re, ' '); });
    return s;
  }

  const SEQ_WORD = /第\s*([一二三四五六七八九十百零两]{1,4}|\d{1,3})\s*(次|份|期|讲|节|章|篇|版|稿|轮|课|周|天|号)/;

  /* 返回 { seq, tag }：tag 只在序号是「显式写出来的」时候填，用于列表里展示 */
  function seqInfo(name) {
    const base = stripDates(String(name || '').replace(/\.[^.]+$/, ''));

    let m = base.match(SEQ_WORD);
    if (m) {
      const n = cnNumber(m[1]);
      if (n != null) return { seq: n, tag: '第' + n + m[2] };
    }

    m = base.match(/[（(【\[]\s*(\d{1,3})\s*[)）】\]]/);
    if (m) return { seq: parseInt(m[1], 10), tag: '#' + parseInt(m[1], 10) };

    m = base.match(/(?:^|[-_\s])(\d{1,3})(?=$|[-_\s])/);
    if (m) return { seq: parseInt(m[1], 10), tag: '#' + parseInt(m[1], 10) };

    m = base.match(/(\d{1,4})$/);
    if (m) return { seq: parseInt(m[1], 10), tag: '' };

    return { seq: null, tag: '' };
  }

  function parseSeqFromName(name) {
    return seqInfo(name).seq;
  }

  /* 去掉扩展名、日期、序号后的主体名：判断「是不是同一个文件」用 */
  function nameKey(name) {
    let base = stripDates(String(name || '').replace(/\.[^.]+$/, ''));
    base = base.replace(new RegExp(SEQ_WORD.source, 'g'), ' ');
    base = base.replace(/[（(【\[]\s*\d{1,3}\s*[)）】\]]/g, ' ');
    base = base.replace(/[\s\-_·.。~]+/g, '');
    return base.toLowerCase();
  }

  function trim(text) {
    let t = String(text || '').replace(/\u0000/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
    return t;
  }

  async function readArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(file);
    });
  }

  async function extractDocx(file) {
    if (!window.mammoth) throw new Error('文档解析组件未加载');
    const buf = await readArrayBuffer(file);
    const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return trim(result.value);
  }

  async function extractSheet(file) {
    if (!window.XLSX) throw new Error('表格解析组件未加载');
    const buf = await readArrayBuffer(file);
    const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
    const parts = [];
    wb.SheetNames.forEach(function (name) {
      const sheet = wb.Sheets[name];
      if (!sheet) return;
      const csv = window.XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv && csv.trim()) parts.push('【' + name + '】\n' + csv);
    });
    return trim(parts.join('\n\n'));
  }

  async function extractPdf(file) {
    if (!window.pdfjsLib) throw new Error('PDF 解析组件未加载');
    const buf = await readArrayBuffer(file);
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const parts = [];
    const maxPages = Math.min(doc.numPages, 80);
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map(function (it) { return it.str || ''; }).join(' ');
      if (line.trim()) parts.push(line);
      page.cleanup();
    }
    try { doc.destroy(); } catch (e) { /* 忽略 */ }
    return trim(parts.join('\n'));
  }

  async function extractText(file) {
    const kind = kindOf(file.name);
    const ext = extOf(file.name);

    /* 纯文本类直接读取，正文可被全文检索 */
    if (TEXT_EXT.indexOf(ext) >= 0) {
      try {
        const buf = await readArrayBuffer(file);
        const text = trim(new TextDecoder('utf-8').decode(new Uint8Array(buf)));
        return text ? { text: text, status: 'done' } : { text: '', status: 'skipped' };
      } catch (e) {
        return { text: '', status: 'failed' };
      }
    }

    if (kind === 'image' || kind === 'other') {
      return { text: '', status: 'skipped' };
    }
    if (kind === 'doc' && extOf(file.name) !== 'docx') {
      return { text: '', status: 'skipped' };
    }
    if (kind === 'sheet' && extOf(file.name) === 'csv') {
      try {
        const buf = await readArrayBuffer(file);
        const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
        return { text: trim(text), status: 'done' };
      } catch (e) {
        return { text: '', status: 'failed' };
      }
    }
    try {
      let text = '';
      if (kind === 'doc') text = await extractDocx(file);
      else if (kind === 'sheet') text = await extractSheet(file);
      else if (kind === 'pdf') text = await extractPdf(file);
      if (!text) return { text: '', status: 'failed' };
      return { text: text, status: 'done' };
    } catch (e) {
      console.warn('[解析失败]', file.name, e);
      return { text: '', status: 'failed' };
    }
  }

  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  window.Parser = {
    extOf: extOf,
    kindOf: kindOf,
    parseDateFromName: parseDateFromName,
    seqInfo: seqInfo,
    parseSeqFromName: parseSeqFromName,
    nameKey: nameKey,
    cnNumber: cnNumber,
    extractText: extractText,
    TEXT_EXT: TEXT_EXT
  };
})();
