/* 文件查看器：直接读取已归档的文件本体预览，不重新下载；
   浏览器无法预览的类型一键转交系统应用打开 */

(function () {
  const MAX_PDF_PAGES = 50;

  let activeUrl = null;
  let currentDoc = null;
  let hitState = { marks: [], pages: [], idx: 0, query: '' };
  let panTarget = null;

  const el = { root: null, body: null, name: null, meta: null, icon: null, external: null,
    hits: null, hitPrev: null, hitNext: null, hitCount: null, hitClose: null,
    pan: null, panRange: null, zoom: null, zoomRange: null };

  function cacheEls() {
    el.root = document.getElementById('viewer');
    el.body = document.getElementById('viewerBody');
    el.name = document.getElementById('viewerName');
    el.meta = document.getElementById('viewerMeta');
    el.icon = document.getElementById('viewerIcon');
    el.external = document.getElementById('viewerExternal');
    el.hits = document.getElementById('viewerHits');
    el.hitPrev = document.getElementById('hitPrev');
    el.hitNext = document.getElementById('hitNext');
    el.hitCount = document.getElementById('hitCount');
    el.hitClose = document.getElementById('hitClose');
    el.pan = document.getElementById('viewerPan');
    el.panRange = document.getElementById('viewerPanRange');
    el.zoom = document.getElementById('viewerZoom');
    el.zoomRange = document.getElementById('viewerZoomRange');
  }

  /* ---------- 搜索命中定位 ---------- */

  function resetHits() {
    hitState = { marks: [], pages: [], idx: 0, query: '' };
    if (el.body) {
      const old = el.body.querySelectorAll('mark.kw-hit-focus, .hit-col-head, .hit-row-head, .hit-line');
      for (let i = 0; i < old.length; i++) {
        old[i].classList.remove('kw-hit-focus');
        old[i].classList.remove('hit-col-head');
        old[i].classList.remove('hit-row-head');
        old[i].classList.remove('hit-line');
      }
    }
    if (el.hits) el.hits.hidden = true;
    if (el.pan) el.pan.hidden = true;
    panTarget = null;
    applyBottomInset();
  }

  /* 在渲染好的 DOM 里查找关键词并包上高亮标记（跳过脚本与样式节点） */
  function highlightDom(rootEl, query) {
    if (!query || !rootEl) return [];
    const marks = [];
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentNode;
        if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.nodeName === 'MARK')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.toLowerCase().indexOf(lower) >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    targets.forEach(function (node) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      let idx = text.toLowerCase().indexOf(lower);
      while (idx >= 0) {
        if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
        const mark = document.createElement('mark');
        mark.className = 'kw-hit';
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        marks.push(mark);
        pos = idx + query.length;
        idx = text.toLowerCase().indexOf(lower, pos);
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    });
    return marks;
  }

  /* 高亮命中词所在的整行/整块：
     纯文本按 .vline 行标记，docx 等结构化内容找块级祖先；
     表格里命中时标到 <tr> 上，让横向一整行都铺浅色块（含冻结行号列）。 */
  function decorateHitLines(rootEl, marks) {
    if (!rootEl || !marks || !marks.length) return;
    const done = [];
    marks.forEach(function (m) {
      if (!m.isConnected) return;
      let t = m.closest('.vline');
      if (!t) {
        /* 表格单元格 → 整行；单元格里再嵌段落时同样落到行上 */
        const cell = m.closest('td, th');
        t = cell ? cell.closest('tr') : null;
      }
      if (!t) t = m.closest('p, li, h1, h2, h3, h4, h5, h6, dd, dt, blockquote');
      if (!t || t === rootEl || done.indexOf(t) >= 0) return;
      done.push(t);
      t.classList.add('hit-line');
    });
  }

  /* 表格表头高亮只跟随「当前」命中词：
     横向表头 = 同列的 thead 单元格；纵向表头 = 该行第一个数据格（跳过冻结序号列）。
     Word 文档里的表格通常没有 thead，此时把第一行当作表头行。 */
  function clearHeaderMarks(rootEl) {
    if (!rootEl) return;
    const old = rootEl.querySelectorAll('.hit-col-head, .hit-row-head');
    for (let i = 0; i < old.length; i++) {
      old[i].classList.remove('hit-col-head');
      old[i].classList.remove('hit-row-head');
    }
  }

  function applyHeaderHighlight(rootEl, mark) {
    if (!rootEl) return;
    clearHeaderMarks(rootEl);
    if (!mark || !mark.isConnected) return;
    const cell = mark.closest('td, th');
    const row = cell && cell.closest('tr');
    if (!cell || !row) return;
    const table = row.closest('table');
    if (!table) return;

    const cells = Array.prototype.slice.call(row.children);
    const col = cells.indexOf(cell);
    if (col < 0) return;

    let headRow = table.querySelector('thead tr');
    if (!headRow) {
      const first = table.rows && table.rows[0];
      if (first && first !== row) headRow = first;
    }
    /* 命中的就是表头行本身：没有可对照的表头，不标 */
    if (headRow && headRow === row) return;
    if (headRow) {
      const heads = Array.prototype.slice.call(headRow.children);
      if (heads[col]) heads[col].classList.add('hit-col-head');
    }

    /* 左侧行号也是行表头的一部分，和首个数据格一起标出 */
    const rowIdx = row.querySelector('.row-idx');
    if (rowIdx) rowIdx.classList.add('hit-row-head');
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].classList.contains('row-idx')) continue;
      cells[i].classList.add('hit-row-head');
      break;
    }
  }

  /* 表格命中行提取：从已经渲染好的表格 DOM 里取表头 + 所有命中行，
     按列对齐后交给居中面板。跳过冻结序号列，隐私样式由 views/ui 层管。 */
  function collectHitRows(rootEl) {
    if (!rootEl) return null;
    const tables = rootEl.querySelectorAll('table');
    let head = [];
    const rows = [];
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t];
      const hitRows = table.querySelectorAll('tr.hit-line');
      if (!hitRows.length) continue;
      if (!head.length) {
        const headRow = table.querySelector('thead tr') || table.rows[0];
        if (headRow) {
          head = Array.prototype.slice.call(headRow.children)
            .filter(function (c) { return !c.classList.contains('row-idx'); })
            .map(function (c) { return c.textContent.trim(); });
        }
      }
      for (let i = 0; i < hitRows.length; i++) {
        const cells = Array.prototype.slice.call(hitRows[i].children)
          .filter(function (c) { return !c.classList.contains('row-idx'); })
          .map(function (c) { return c.textContent.trim(); });
        if (cells.some(function (c) { return c; })) rows.push(cells);
      }
    }
    return rows.length ? { head: head, rows: rows } : null;
  }

  async function maybeOpenHitPanel(query) {
    if (!query) return;
    let on = true;
    try { on = await DB.getSetting('searchRowPanel', true) !== false; } catch (e) { /* 读不到就按默认开 */ }
    if (!on) return;
    const data = collectHitRows(el.body);
    if (!data) return;
    data.query = query;
    UI.openRowPanel('命中 ' + data.rows.length + ' 行 · ' + query, UI.rowTableHtml(data), '表格横向信息 · 已同步提取');
  }

  /* PDF 没有可选文本层：用 getTextContent 找到命中的页码 */
  async function pdfHitPages(pdf, query) {
    const pages = [];
    const lower = query.toLowerCase();
    const total = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= total; i++) {
      try {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map(function (it) { return it.str || ''; }).join('').toLowerCase();
        if (text.indexOf(lower) >= 0) pages.push(i);
        page.cleanup();
      } catch (e) { /* 单页失败不阻断 */ }
    }
    return pages;
  }

  /* ---------- 底部浮层避让 ----------
     跳转条与平移滑块是浮在内容之上的，命中行贴近末尾时会被压住。
     这里统一算「浮层占掉多少高度」，用于滚动避让与底部留白。 */

  function bottomInset() {
    if (!el.root) return 0;
    const bar = el.root.querySelector('.viewer-bottom');
    if (!bar) return 0;
    const hitsOn = el.hits && !el.hits.hidden;
    const panOn = el.pan && !el.pan.hidden;
    if (!hitsOn && !panOn) return 0;
    const h = bar.getBoundingClientRect().height;
    if (!h) return 0;
    /* 14px 是浮层距底部的偏移，再留 8px 呼吸位 */
    return Math.round(h) + 14 + 8;
  }

  /* 底部留白：即使手动滚到最底，最后几行也不会被浮层压住 */
  function applyBottomInset() {
    if (!el.body) return;
    const px = bottomInset();
    el.body.style.paddingBottom = px ? px + 'px' : '';
  }

  /* 把命中项滚进「真正可见」的区域：纵向避开底部浮层，横向避开冻结行号列。
     返回需要滚动的位移；都是可视坐标，按 zoom 折算回滚动单位。 */
  function hitDelta(node) {
    if (!el.body || !node || !node.getBoundingClientRect) return null;
    const bR = el.body.getBoundingClientRect();
    const mR = node.getBoundingClientRect();
    if (!mR.height && !mR.width) return null;
    const zoom = parseFloat(el.body.style.zoom) || 1;
    const bar = bottomInset();
    const idxCell = el.body.querySelector('.sheet-view td.row-idx');
    const stickyW = idxCell ? idxCell.getBoundingClientRect().width : 0;
    const areaTop = bR.top + 12;
    const areaBottom = bR.bottom - bar - 12;
    const areaLeft = bR.left + stickyW + 12;
    const areaRight = bR.right - 12;

    /* 命中处放到可视区正中，不再只在快出屏时挪一点。
       表格很宽、命中块比可视区还大时退回贴边，优先露出左上角。 */
    const areaH = areaBottom - areaTop;
    const areaW = areaRight - areaLeft;
    let dTop = (mR.top - areaTop) - (areaH - mR.height) / 2;
    let dLeft = (mR.left - areaLeft) - (areaW - mR.width) / 2;
    if (mR.height >= areaH) dTop = mR.top - areaTop;
    if (mR.width >= areaW) dLeft = mR.left - areaLeft;

    if (Math.abs(dTop) < 2 && Math.abs(dLeft) < 2) return null;
    const maxTop = Math.max(0, (el.body.scrollHeight - el.body.clientHeight) / zoom);
    const maxLeft = Math.max(0, (el.body.scrollWidth - el.body.clientWidth) / zoom);
    return {
      top: Math.min(maxTop, Math.max(0, el.body.scrollTop + dTop / zoom)),
      left: Math.min(maxLeft, Math.max(0, el.body.scrollLeft + dLeft / zoom))
    };
  }

  let hitFixTimer = 0;

  function scrollHitIntoView(node, smooth) {
    const target = hitDelta(node);
    if (!target) return;
    if (smooth) {
      try {
        el.body.scrollTo({ top: target.top, left: target.left, behavior: 'smooth' });
        return;
      } catch (e) { /* 老浏览器不支持对象参数，退回直接赋值 */ }
    }
    el.body.scrollTop = target.top;
    el.body.scrollLeft = target.left;
  }

  /* 平滑滚动 + 布局稳定后再校验一次：浮层高度、命中词放大都会改变行高，
     一次算不准，这里在动画结束后补一次硬校正，保证末行也不被压住。 */
  function scheduleHitFix(node) {
    if (hitFixTimer) clearTimeout(hitFixTimer);
    hitFixTimer = setTimeout(function () {
      hitFixTimer = 0;
      if (!node || !node.isConnected) return;
      scrollHitIntoView(node, false);
    }, 460);
  }

  function updateHitBar() {
    if (!el.hits) return;
    const total = hitState.marks.length || hitState.pages.length;
    if (!hitState.query || !total) {
      el.hits.hidden = true;
      applyBottomInset();
      return;
    }
    el.hits.hidden = false;
    if (el.hitCount) el.hitCount.textContent =
      (hitState.idx + 1) + ' / ' + total + (hitState.pages.length ? ' 页' : ' 处');
    applyBottomInset();
  }

  function gotoHit(i) {
    const total = hitState.marks.length || hitState.pages.length;
    if (!total) return;
    hitState.idx = ((i % total) + total) % total;
    /* 先把底部浮层留白算好，再量命中位置，否则会按旧的可用区算 */
    applyBottomInset();
    let node = null;
    if (hitState.marks.length) {
      hitState.marks.forEach(function (m, j) {
        const cur = j === hitState.idx;
        m.classList.toggle('on', cur);
        /* v2.7.0：当前命中词放大一倍显示，切换命中处时只保留一处放大 */
        m.classList.toggle('kw-hit-focus', cur);
      });
      node = hitState.marks[hitState.idx];
      /* 表头浅色高亮跟随当前命中词，切换时清掉上一处的表头标记 */
      applyHeaderHighlight(el.body, node);
    } else if (hitState.pages.length) {
      node = el.body.querySelectorAll('.pdf-page')[hitState.pages[hitState.idx] - 1];
    }
    scrollHitIntoView(node, true);
    scheduleHitFix(node);
    updateHitBar();
    /* 定位过程中可能发生横/纵向滚动，滑块位置需要立刻跟上 */
    requestPanSync();
  }

  function setupHits(query, marks, pages) {
    hitState = { marks: marks, pages: pages || [], idx: 0, query: query };
    updateHitBar();
    if (hitState.query && (marks.length || pages.length)) gotoHit(0);
  }

  function bindHitNav() {
    if (!el.hits || el.hits.dataset.bound) return;
    el.hits.dataset.bound = '1';
    el.hitPrev.addEventListener('click', function () { gotoHit(hitState.idx - 1); });
    el.hitNext.addEventListener('click', function () { gotoHit(hitState.idx + 1); });
    el.hitClose.addEventListener('click', function () {
      if (el.hits) el.hits.hidden = true;
      /* 收起定位条后回收底部留白，内容可以继续贴底显示 */
      applyBottomInset();
    });
  }

  /* ---------- 左右平移滑块 ---------- */

  /* 滑块位置跟随真实滚动位置：命中定位、手动滚动、缩放后都要对齐 */
  function syncPan() {
    if (!el.panRange || !panTarget) return;
    const max = Math.max(1, Math.round(panTarget.scrollWidth - panTarget.clientWidth));
    if (parseFloat(el.panRange.max) !== max) el.panRange.max = String(max);
    const v = Math.round(Math.max(0, Math.min(max, panTarget.scrollLeft || 0)));
    if (el.panRange.value !== String(v)) el.panRange.value = String(v);
  }

  let panRaf = 0;
  function requestPanSync() {
    if (panRaf) return;
    panRaf = window.requestAnimationFrame(function () {
      panRaf = 0;
      syncPan();
    });
  }

  function setupPan() {
    if (!el.pan || !el.panRange || !el.body) return;
    /* 横向滚动可能发生在 viewerBody 自身或其内部的 .sheet-view */
    let target = null;
    if (el.body.scrollWidth > el.body.clientWidth + 4) target = el.body;
    else {
      const inner = el.body.querySelector('.sheet-view');
      if (inner && inner.scrollWidth > inner.clientWidth + 4) target = inner;
    }
    panTarget = target;
    if (!target) {
      el.pan.hidden = true;
      applyBottomInset();
      return;
    }
    const max = target.scrollWidth - target.clientWidth;
    el.pan.hidden = false;
    el.panRange.max = String(Math.max(1, Math.round(max)));
    el.panRange.value = String(Math.round(target.scrollLeft || 0));
    applyBottomInset();
    /* 目标元素换了的话，补上滚动监听，保证滑块跟着内容走 */
    if (target.dataset && target.dataset.panBound !== '1') {
      target.dataset.panBound = '1';
      target.addEventListener('scroll', requestPanSync, { passive: true });
    }
  }

  function bindPan() {
    if (!el.pan || el.pan.dataset.bound) return;
    el.pan.dataset.bound = '1';
    el.panRange.addEventListener('input', function () {
      if (panTarget) panTarget.scrollLeft = parseInt(el.panRange.value, 10) || 0;
    });
    /* 结果页里滚动（含命中定位的平滑滚动）时，滑块同步到当前位置 */
    if (el.body) el.body.addEventListener('scroll', requestPanSync, { passive: true });
    /* 窗口尺寸变化时重新计算是否需要滑块及其行程 */
    window.addEventListener('resize', function () {
      if (el.root && el.root.classList.contains('open')) setupPan();
    });
  }

  /* ---------- 竖向缩放滑块（查看内容整体放大缩小，不遮挡其他栏目） ---------- */

  let zoomVal = 1;

  function loadZoom() {
    const v = parseFloat(localStorage.getItem('viewerZoom'));
    zoomVal = (v >= 0.7 && v <= 2.2) ? v : 1;
  }

  function applyZoom() {
    if (!el.body) return;
    el.body.style.zoom = zoomVal === 1 ? '' : String(zoomVal);
    if (el.zoomRange) el.zoomRange.value = String(zoomVal);
  }

  function setupZoom() {
    if (!el.zoom || !el.root) return;
    const card = el.root.querySelector('.viewer-card');
    if (card) card.classList.add('zoomable');
    el.zoom.hidden = false;
    applyZoom();
  }

  function bindZoom() {
    if (!el.zoom || el.zoom.dataset.bound) return;
    el.zoom.dataset.bound = '1';
    el.zoomRange.addEventListener('input', function () {
      const prev = parseFloat(el.body.style.zoom) || 1;
      zoomVal = parseFloat(el.zoomRange.value) || 1;
      try { localStorage.setItem('viewerZoom', String(zoomVal)); } catch (e) { /* 忽略 */ }
      const top = el.body.scrollTop;
      applyZoom();
      /* 缩放后按比例保持阅读位置，横向复位避免内容滚出视野 */
      el.body.scrollTop = Math.round(top * (zoomVal / prev));
      el.body.scrollLeft = 0;
      setupPan();
    });
  }

  function newUrl(blob) {
    if (activeUrl) { try { URL.revokeObjectURL(activeUrl); } catch (e) { /* 忽略 */ } }
    activeUrl = URL.createObjectURL(blob);
    return activeUrl;
  }

  function setMeta(t) { if (el.meta) el.meta.textContent = t || ''; }

  /* ---------- 各类型渲染 ---------- */

  /* ---------- 图片：预览 + 本机识别出的文字 ---------- */

  let ocrUnsub = null;

  function stopOcrWatch() {
    if (ocrUnsub) { try { ocrUnsub(); } catch (e) { /* 忽略 */ } ocrUnsub = null; }
  }

  function ocrActionsHtml(st) {
    if (st === 'done') {
      return '<div class="ocr-actions">' +
        '<button class="btn sm" data-ocr-again type="button">重新识别</button>' +
        '<button class="btn sm" data-ocr-clear-one type="button">清除文字</button>' +
        '</div>';
    }
    return '<div class="ocr-actions">' +
      '<button class="btn primary sm" data-ocr-run-one type="button">' + (st === 'failed' ? '重试识别' : '识别图片文字') + '</button>' +
      '</div>';
  }

  function paintOcrBox(box, doc) {
    if (!box) return;
    const st = doc.ocrStatus || 'none';
    const chars = doc.ocrChars || (doc.ocrText || '').length;
    let head = '<div class="ocr-head"><span class="ocr-title">图片中的文字</span>';
    if (st === 'done') {
      head += '<span class="ocr-meta">' + chars + ' 字' + (doc.ocrConf ? ' · 置信度 ' + doc.ocrConf + '%' : '') + '</span>';
    }
    head += '</div>';

    if (st === 'done' && doc.ocrText) {
      box.innerHTML = head + '<pre class="ocr-text"></pre>' + ocrActionsHtml('done');
      box.querySelector('.ocr-text').textContent = doc.ocrText;
      return;
    }
    if (st === 'pending') {
      box.innerHTML = head + '<p class="ocr-note">正在识别文字，稍等一下…</p>';
      return;
    }
    if (st === 'empty') {
      box.innerHTML = head + '<p class="ocr-note">这张图片里没有识别到文字，可能是纯照片或图案。</p>' + ocrActionsHtml('empty');
      return;
    }
    if (st === 'failed') {
      box.innerHTML = head + '<p class="ocr-note">上次识别没有成功' + (doc.ocrErr ? '：' + UI.esc(doc.ocrErr) : '') + '。</p>' + ocrActionsHtml('failed');
      return;
    }
    box.innerHTML = head +
      '<p class="ocr-note">照片、截图里的文字可以在本机识别出来，识别后的内容能被关键词检索到。</p>' +
      ocrActionsHtml('none') +
      '<p class="ocr-hint">首次识别需要加载模型（约 6~8MB），之后离线也能用；图片不会上传，识别结果只存在本机。</p>';
  }

  async function runOcrForImage(doc, box) {
    if (!window.OCRJob) return;
    stopOcrWatch();
    box.innerHTML = '<div class="ocr-head"><span class="ocr-title">正在识别文字</span><span class="ocr-meta ocr-pct">0%</span></div>' +
      '<div class="ocr-bar"><i style="width:2%"></i></div>' +
      '<p class="ocr-note ocr-stage">正在准备…</p>';

    ocrUnsub = window.OCRJob.on(function (evt) {
      if (!evt || evt.docId !== doc.id || evt.type !== 'progress') return;
      const pct = Math.round((evt.p || 0) * 100);
      const pEl = box.querySelector('.ocr-pct');
      const bar = box.querySelector('.ocr-bar i');
      const stage = box.querySelector('.ocr-stage');
      if (pEl) pEl.textContent = pct + '%';
      if (bar) bar.style.width = Math.max(2, pct) + '%';
      if (stage && evt.stage) stage.textContent = evt.stage + '…';
    });

    try {
      const res = await window.OCRJob.recognizeDoc(doc);
      stopOcrWatch();
      paintOcrBox(box, doc);
      if (hitState.query) {
        const marks = highlightDom(box, hitState.query);
        if (marks.length) setupHits(hitState.query, marks, []);
      }
      UI.toast(res.text ? '已识别 ' + res.text.length + ' 字，现在可以搜索到了' : '这张图片没有识别到文字', res.text ? 'ok' : '');
      if (window.App && window.App.refresh) window.App.refresh();
    } catch (err) {
      stopOcrWatch();
      doc.ocrStatus = 'failed';
      doc.ocrErr = (err && err.message) || '识别失败';
      paintOcrBox(box, doc);
      UI.toast('识别失败：' + doc.ocrErr, 'err');
    }
  }

  /* 后台还在识别时打开查看器：跟着进度刷新面板，识别完自动出文本 */
  function watchOcrProgress(doc, box) {
    if (!window.OCRJob) return;
    stopOcrWatch();
    ocrUnsub = window.OCRJob.on(function (evt) {
      if (!evt || evt.docId !== doc.id) return;
      if (evt.type === 'progress') {
        const pct = Math.round((evt.p || 0) * 100);
        let pEl = box.querySelector('.ocr-pct');
        if (!pEl) {
          box.innerHTML = '<div class="ocr-head"><span class="ocr-title">正在识别文字</span><span class="ocr-meta ocr-pct">' + pct + '%</span></div>' +
            '<div class="ocr-bar"><i style="width:2%"></i></div>' +
            '<p class="ocr-note ocr-stage">' + UI.esc(evt.stage || '正在准备') + '…</p>';
          pEl = box.querySelector('.ocr-pct');
        }
        const bar = box.querySelector('.ocr-bar i');
        const stage = box.querySelector('.ocr-stage');
        if (pEl) pEl.textContent = pct + '%';
        if (bar) bar.style.width = Math.max(2, pct) + '%';
        if (stage && evt.stage) stage.textContent = evt.stage + '…';
        return;
      }
      if (evt.type === 'done' || evt.type === 'error') {
        stopOcrWatch();
        DB.getDocument(doc.id).then(function (fresh) {
          if (!fresh) return;
          doc.ocrStatus = fresh.ocrStatus;
          doc.ocrText = fresh.ocrText;
          doc.ocrChars = fresh.ocrChars;
          doc.ocrConf = fresh.ocrConf;
          doc.ocrErr = fresh.ocrErr;
          paintOcrBox(box, doc);
          setMeta(UI.fmtSize(doc.size) + ' · 图片' + (doc.ocrStatus === 'done' ? ' · 文字 ' + (doc.ocrChars || 0) + ' 字' : ''));
          if (hitState.query) {
            const marks = highlightDom(box, hitState.query);
            if (marks.length) setupHits(hitState.query, marks, []);
          }
        }).catch(function () { /* 忽略 */ });
      }
    });
  }

  function renderImage(doc) {
    const chars = doc.ocrChars || (doc.ocrText || '').length;
    setMeta(UI.fmtSize(doc.size) + ' · 图片' + (doc.ocrStatus === 'done' ? ' · 文字 ' + chars + ' 字' : ''));
    el.body.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'viewer-img';
    img.alt = doc.name;
    el.body.appendChild(img);
    img.src = newUrl(doc.blob);

    const box = document.createElement('div');
    box.className = 'ocr-box neu';
    el.body.appendChild(box);
    paintOcrBox(box, doc);
    if (doc.ocrStatus === 'pending') watchOcrProgress(doc, box);
  }

  async function renderText(doc) {
    const buf = await doc.blob.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(new Uint8Array(buf)).replace(/\u0000/g, '');
    setMeta(UI.fmtSize(doc.size) + ' · 纯文本 ' + text.length + ' 字');
    el.body.innerHTML = '<pre class="viewer-text"></pre>';
    const pre = el.body.firstChild;
    /* 按行拆分成 .vline，方便搜索命中时整行高亮 */
    const lines = (text || '（空文件）').split('\n');
    lines.forEach(function (line, i) {
      const sp = document.createElement('span');
      sp.className = 'vline';
      sp.textContent = line;
      pre.appendChild(sp);
      if (i < lines.length - 1) pre.appendChild(document.createTextNode('\n'));
    });
  }

  async function renderDocx(doc) {
    if (!window.mammoth) throw new Error('预览组件未加载');
    const buf = await doc.blob.arrayBuffer();
    const res = await window.mammoth.convertToHtml({ arrayBuffer: buf });
    const html = res && res.value ? res.value : '';
    setMeta(UI.fmtSize(doc.size) + ' · Word 文档');
    el.body.innerHTML = '<div class="docx-view"></div>';
    const box = el.body.firstChild;
    if (html.trim()) box.innerHTML = html;
    else box.innerHTML = '<div class="viewer-fallback-note">这个文档没有可显示的文字内容</div>';
  }

  /*
   * 表格 HTML 重排：
   * 1. 首行抽出为 <thead>（冻结顶行表头）
   * 2. 每行行首插入序号列 <td class="row-idx">（冻结左列，同时显示序号）
   */
  function buildFreezeTable(rawHtml) {
    let rowNo = 0;
    let isFirstRow = true;
    let out = rawHtml.replace(/<tr([^>]*)>([\s\S]*?)<\/tr>/g, function (m, attrs, inner) {
      if (isFirstRow) {
        isFirstRow = false;
        const headInner = inner.replace(/<td/g, '<th').replace(/<\/td>/g, '</th>');
        return '<thead><tr' + attrs + '><th class="row-idx">#</th>' + headInner + '</tr></thead>';
      }
      rowNo++;
      return '<tr' + attrs + '><td class="row-idx">' + rowNo + '</td>' + inner + '</tr>';
    });
    return '<tbody>' + out + '</tbody>';
  }

  async function renderSheet(doc) {
    if (!window.XLSX) throw new Error('预览组件未加载');
    const buf = await doc.blob.arrayBuffer();
    const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
    let html = '';
    wb.SheetNames.forEach(function (name) {
      const sheet = wb.Sheets[name];
      if (!sheet) return;
      html += '<div class="sheet-name hand">' + UI.esc(name) + '</div>' +
        '<div class="sheet-freeze">' + buildFreezeTable(window.XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' })) + '</div>';
    });
    setMeta(UI.fmtSize(doc.size) + ' · 表格');
    el.body.innerHTML = html ? '<div class="sheet-view">' + html + '</div>'
      : '<div class="viewer-fallback-note">表格没有可显示的内容</div>';
  }

  /* PDF 文本层：把每页文字按坐标铺成透明可选文本，便于选中、复制、
     交给翻译工具。画布仍负责显示，这层只承载文字。 */
  function buildPdfTextLayer(vp, content) {
    const layer = document.createElement('div');
    layer.className = 'pdf-text-layer';
    layer.setAttribute('aria-hidden', 'true');
    const items = (content && content.items) || [];
    /* 极端页（上千个文本块）不铺，避免节点过多拖慢滚动 */
    if (!items.length || items.length > 1500) return layer;
    const ctx = document.createElement('canvas').getContext('2d');
    const fontCache = {};
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.str || !it.str.trim()) continue;
      const tx = window.pdfjsLib.Util.transform(vp.transform, it.transform);
      /* 只处理水平文本；旋转文本跳过，避免整页错位 */
      if (Math.abs(tx[1]) > 0.02 || Math.abs(tx[2]) > 0.02) continue;
      const fontH = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || (it.height || 0) * vp.scale;
      if (!fontH || fontH < 1) continue;
      const span = document.createElement('span');
      span.textContent = it.str;
      span.style.left = tx[4].toFixed(2) + 'px';
      span.style.top = (tx[5] - fontH).toFixed(2) + 'px';
      const key = fontH.toFixed(1);
      if (!fontCache[key]) fontCache[key] = '400 ' + key + 'px sans-serif';
      span.style.font = fontCache[key];
      /* 按原始文字宽度横向缩放，让选中框贴合原排版 */
      const target = (it.width || 0) * vp.scale;
      if (target > 0) {
        ctx.font = fontCache[key];
        const measured = ctx.measureText(it.str).width;
        if (measured > 0) span.style.transform = 'scaleX(' + (target / measured).toFixed(3) + ')';
      }
      layer.appendChild(span);
    }
    return layer;
  }

  async function renderPdf(doc, query) {
    if (!window.pdfjsLib) throw new Error('预览组件未加载');
    const buf = await doc.blob.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = query ? await pdfHitPages(pdf, query) : [];
    const total = pdf.numPages;
    setMeta(UI.fmtSize(doc.size) + ' · PDF 共 ' + total + ' 页' +
      (total > MAX_PDF_PAGES ? '（已显示前 ' + MAX_PDF_PAGES + ' 页）' : ''));
    el.body.innerHTML = '';
    const n = Math.min(total, MAX_PDF_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.4, Math.min(2, (el.body.clientWidth - 30) / base.width));
      const vp = page.getViewport({ scale: scale });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      if (pages.indexOf(i) >= 0) wrap.classList.add('hit-page');
      /* 画布与文字层共用一个精确定位的舞台，保证坐标对齐 */
      const stage = document.createElement('div');
      stage.className = 'pdf-stage';
      stage.style.width = Math.round(vp.width) + 'px';
      stage.style.height = Math.round(vp.height) + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      stage.appendChild(canvas);
      wrap.appendChild(stage);
      el.body.appendChild(wrap);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      /* 有文字层就铺上去；扫描件没有文字层，静默跳过只显示图像 */
      try {
        const content = await page.getTextContent();
        stage.appendChild(buildPdfTextLayer(vp, content));
      } catch (e) { /* 忽略：该页无可选文本 */ }
      page.cleanup();
    }
    try { pdf.destroy(); } catch (e) { /* 忽略 */ }
    if (query) setupHits(query, [], pages);
  }

  function renderFallback(doc) {
    const ext = (doc.ext || '').toUpperCase();
    setMeta(UI.fmtSize(doc.size) + (ext ? ' · ' + ext : ''));
    el.body.innerHTML =
      '<div class="viewer-fallback">' +
      '<span class="icon-box">' + UI.icon('file') + '</span>' +
      '<h3>浏览器内无法直接预览</h3>' +
      '<p>' + UI.esc(ext || '该类型') + ' 文件不在内置预览范围内。点下方按钮，文件本体不会重新下载，直接交给手机或电脑自带的办公软件打开。</p>' +
      '<button class="btn primary" data-viewer-external type="button">' + UI.icon('external') + '用系统应用打开</button>' +
      '</div>';
  }

  /* ---------- 查看记录 ---------- */

  async function recordLog(doc) {
    try {
      await DB.addViewLog({ docId: doc.id, name: doc.name, ext: doc.ext || '', viewedAt: Date.now() });
    } catch (e) { /* 记录失败不影响查看 */ }
  }

  /* 打开前补提取：之前没提取到正文的文件，查看一次后即可被全文搜索 */
  async function ensureExtracted(doc) {
    const ext = Parser.extOf(doc.name || '');
    const kind = Parser.kindOf(doc.name || '');
    const can = ext === 'docx' || ext === 'csv' || ext === 'xlsx' ||
      (Parser.TEXT_EXT || []).indexOf(ext) >= 0 || kind === 'pdf';
    if (doc.extractStatus === 'done' || !can || !doc.blob) return false;
    try {
      const pseudo = { name: doc.name, arrayBuffer: function () { return doc.blob.arrayBuffer(); } };
      const parsed = await Parser.extractText(pseudo);
      if (parsed.status === 'done' && parsed.text) {
        await DB.updateDocument(doc.id, { fullText: parsed.text, extractStatus: 'done' });
        doc.fullText = parsed.text;
        doc.extractStatus = 'done';
        return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /* ---------- 开关 ---------- */

  function close() {
    if (!el.root || !el.root.classList.contains('open')) return;
    resetHits();
    stopOcrWatch();
    if (UI.rowPanelOpen && UI.rowPanelOpen()) UI.closeRowPanel();
    if (el.zoom) el.zoom.hidden = true;
    const card = el.root.querySelector('.viewer-card');
    if (card) card.classList.remove('zoomable');
    if (el.body) el.body.style.zoom = '';
    el.root.classList.remove('open');
    el.root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setTimeout(function () {
      if (el.body) el.body.innerHTML = '';
      if (activeUrl) { try { URL.revokeObjectURL(activeUrl); } catch (e) { /* 忽略 */ } activeUrl = null; }
      currentDoc = null;
    }, 280);
  }

  function externalOpen(doc) {
    const d = doc || currentDoc;
    if (!d || !d.blob) { UI.toast('没有可打开的文件本体'); return; }
    const url = URL.createObjectURL(d.blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    UI.toast('已交给系统应用打开');
  }

  async function open(doc, opts) {
    opts = opts || {};
    const query = (opts.query || '').trim();
    if (!doc) return;
    if (!doc.blob) { UI.toast('这份记录没有文件本体，无法查看'); return; }
    cacheEls();
    if (!el.root) return;

    currentDoc = doc;
    resetHits();
    bindHitNav();
    bindPan();
    bindZoom();
    await recordLog(doc);

    const kind = Parser.kindOf(doc.name || '');
    el.name.textContent = doc.name;
    el.icon.className = 'icon-box ' + kind;
    el.icon.innerHTML = UI.icon(UI.kindIcon(kind));
    el.body.innerHTML =
      '<div class="viewer-loading"><span class="icon-box ' + kind + '">' + UI.icon(UI.kindIcon(kind)) + '</span><p>正在打开…</p></div>';
    el.root.classList.add('open');
    el.root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    try {
      const ext = Parser.extOf(doc.name || '');
      if (kind === 'image') renderImage(doc);
      else if (kind === 'pdf') await renderPdf(doc, query);
      else if (kind === 'doc' && ext === 'docx') await renderDocx(doc);
      else if (kind === 'sheet') await renderSheet(doc);
      else if ((Parser.TEXT_EXT || []).indexOf(ext) >= 0) await renderText(doc);
      else renderFallback(doc);

      /* 文本类内容渲染完做关键词高亮、整行高亮与定位 */
      if (query && kind !== 'pdf') {
        const marks = highlightDom(el.body, query);
        decorateHitLines(el.body, marks);
        setupHits(query, marks, []);
        maybeOpenHitPanel(query);
      }

      /* 内容横向溢出时显示左右平移滑块；竖向缩放滑块就位 */
      setupPan();
      setupZoom();
    } catch (err) {
      console.warn('[查看失败]', doc.name, err);
      el.body.innerHTML =
        '<div class="viewer-fallback">' +
        '<span class="icon-box other">' + UI.icon('file') + '</span>' +
        '<h3>预览失败</h3>' +
        '<p>' + UI.esc((err && err.message) || '文件内容无法解析') + '。可以尝试用系统应用打开。</p>' +
        '<button class="btn primary" data-viewer-external type="button">' + UI.icon('external') + '用系统应用打开</button>' +
        '</div>';
    }

    /* 渲染完成后后台补提取，完成后提示可搜索 */
    ensureExtracted(doc).then(function (ex) {
      if (ex) UI.toast('已提取正文 ' + (doc.fullText || '').length + ' 字，现在可以搜索到了', 'ok');
    }).catch(function () { /* 忽略 */ });
  }

  function bindOnce() {
    cacheEls();
    loadZoom();
    if (!el.root || el.root.dataset.bound) return;
    el.root.dataset.bound = '1';
    el.root.addEventListener('click', async function (e) {
      if (e.target.closest('[data-viewer-close]')) { close(); return; }
      if (e.target.closest('[data-viewer-external]')) { externalOpen(); return; }

      const runBtn = e.target.closest('[data-ocr-run-one]') || e.target.closest('[data-ocr-again]');
      if (runBtn) {
        const box = el.body && el.body.querySelector('.ocr-box');
        if (box && currentDoc) runOcrForImage(currentDoc, box);
        return;
      }
      if (e.target.closest('[data-ocr-clear-one]')) {
        const box = el.body && el.body.querySelector('.ocr-box');
        if (box && currentDoc && window.OCRJob) {
          await window.OCRJob.clearText(currentDoc.id);
          paintOcrBox(box, currentDoc);
          setMeta(UI.fmtSize(currentDoc.size) + ' · 图片');
          UI.toast('已清除这份图片的识别文字（图片本身保留）');
          if (window.App && window.App.refresh) window.App.refresh();
        }
        return;
      }
    });
    if (el.external) {
      el.external.addEventListener('click', function () { externalOpen(); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.root.classList.contains('open')) close();
    });
  }

  bindOnce();

  window.Viewer = {
    open: open,
    close: close,
    externalOpen: externalOpen
  };
})();
