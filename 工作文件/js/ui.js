/* 通用 UI：图标、提示、抽屉、确认框、进度 */

(function () {
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtDate(iso, withYear) {
    if (!iso) return '—';
    const s = String(iso);
    if (s.length < 10) return s;
    return withYear ? s : s.slice(5).replace('-', '-');
  }

  function monthLabel(ym) {
    if (!ym || ym === 'all') return '全部';
    const parts = String(ym).split('-');
    if (parts.length < 2) return ym;
    return parts[0] + '年' + parseInt(parts[1], 10) + '月';
  }

  const ICONS = {
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 9h16M4 14.5h16M10 9v12" stroke="currentColor" stroke-width="1.4"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 16V9h2.2a2 2 0 0 1 0 4H8M13 16V9h1.6a3.5 3.5 0 0 1 0 7H13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9.5" r="1.6" fill="currentColor"/><path d="M5.5 18l5-5.4 3.6 3.2 3-2.6 2.4 2.4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="12" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.6 7l1.2-2h4.4l1.2 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    template: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h9l5 5v11H5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 10h7M9 14h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 4h4M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10M8 11l4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V6M8 9l4-4 4 4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="1.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sort: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14M4 16l3 3 3-3M17 19V5M14 8l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    database: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.2-2.9 7.5-7 9-4.1-1.5-7-4.8-7-9V6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3v4h4M9 12h6M9 16h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 14v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.5 12V8M4.5 12h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8.5V12l2.6 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.6" height="6.6" rx="2" fill="currentColor"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="2" fill="currentColor"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="2" fill="currentColor"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="2" fill="currentColor"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 20v-6h5v6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    stat: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="12" width="4.4" height="8.5" rx="1.6" fill="currentColor"/><rect x="9.8" y="6" width="4.4" height="14.5" rx="1.6" fill="currentColor"/><rect x="16.1" y="9" width="4.4" height="11.5" rx="1.6" fill="currentColor"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 3.8l1 2.6a5.7 5.7 0 0 1 2.3 1.3l2.7-.5 1.3 2.3-1.9 2a5.9 5.9 0 0 1 0 2.7l1.9 2-1.3 2.3-2.7-.5a5.7 5.7 0 0 1-2.3 1.3l-1 2.7h-2.6l-.7-2.7a5.7 5.7 0 0 1-2.3-1.3l-2.7.5-1.3-2.3 1.9-2a5.9 5.9 0 0 1 0-2.7l-1.9-2 1.3-2.3 2.7.5a5.7 5.7 0 0 1 2.3-1.3l.7-2.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.4-6.1-6.4-10.6a6.4 6.4 0 1 1 12.8 0C18.4 14.9 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="10.2" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4M6 4.8h9.6l-1.6 3.6 1.6 3.6H6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 8.9V19a1.6 1.6 0 0 0 1.6 1.6h10.8A1.6 1.6 0 0 0 19 19V8.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.8 13h4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.6 13.4l2.2-7.2A2 2 0 0 1 7.7 4.8h8.6a2 2 0 0 1 1.9 1.4l2.2 7.2v4.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3.6 13.4h4.2l1.2 2.2h6l1.2-2.2h4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h8.4l7.6 7.6-6.9 6.9L5.5 12.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="9" cy="9.4" r="1.5" fill="currentColor"/></svg>'
  };

  function icon(name, cls) {
    const svg = ICONS[name] || ICONS.file;
    return cls ? svg.replace('<svg ', '<svg class="' + cls + '" ') : svg;
  }

  function kindIcon(name) {
    const map = { doc: 'doc', sheet: 'sheet', pdf: 'pdf', image: 'image', other: 'other' };
    return map[name] || 'other';
  }

  /* 完成庆祝动画：事件补齐时全屏轻量反馈 */
  function celebrate(title, sub) {
    const old = document.querySelector('.celebrate');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'celebrate';
    const colors = ['#6C8BF5', '#34C778', '#F2A36B', '#5574E8'];
    let dots = '';
    for (let i = 0; i < 10; i++) {
      const ang = (Math.PI * 2 * i) / 10 + Math.random() * 0.6;
      const dist = 72 + Math.random() * 64;
      dots += '<i class="confetti" style="background:' + colors[i % 4] +
        ';--dx:' + Math.round(Math.cos(ang) * dist) + 'px' +
        ';--dy:' + Math.round(Math.sin(ang) * dist) + 'px"></i>';
    }
    el.innerHTML = '<div class="celebrate-card">' + dots +
      '<div class="ring"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<h3></h3><p></p></div>';
    el.querySelector('h3').textContent = title || '已完成';
    el.querySelector('p').textContent = sub || '';
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 1700);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 2100);
  }

  /* 吐司 */
  let toastTimer = null;
  function toast(message, type) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast on' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast';
    }, 2400);
  }

  /* 抽屉 */
  const drawer = function () { return $('#drawer'); };
  let drawerOnClose = null;

  function openDrawer(title, html, onMount) {
    const el = drawer();
    if (!el) return;
    $('#drawerTitle').textContent = title || '';
    /* 用克隆节点替换 body：旧 body 上的事件监听器随节点一起销毁，
       避免多次打开抽屉后监听器累积、一次点击触发多个旧处理器 */
    const oldBody = $('#drawerBody');
    const body = oldBody.cloneNode(false);
    oldBody.replaceWith(body);
    body.innerHTML = html || '';
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (typeof onMount === 'function') onMount(body);
    const first = body.querySelector('input, select, textarea, button');
    if (first && window.matchMedia('(min-width: 900px)').matches) {
      setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (e) {} }, 260);
    }
  }

  function closeDrawer() {
    const el = drawer();
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (typeof drawerOnClose === 'function') {
      const cb = drawerOnClose;
      drawerOnClose = null;
      cb();
    }
  }

  function onDrawerClose(cb) { drawerOnClose = cb; }

  /* 确认框 */
  let modalResolve = null;

  function confirmBox(opts) {
    opts = opts || {};
    const el = $('#modal');
    const card = $('#modalCard');
    if (!el || !card) return Promise.resolve(false);
    card.innerHTML =
      '<h3>' + esc(opts.title || '确认操作') + '</h3>' +
      '<p>' + (opts.message || '') + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-modal="cancel" type="button">' + esc(opts.cancelText || '取消') + '</button>' +
      '<button class="btn ' + (opts.danger ? 'danger solid' : 'primary') + '" data-modal="ok" type="button">' + esc(opts.okText || '确定') + '</button>' +
      '</div>';
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    return new Promise(function (resolve) {
      modalResolve = resolve;
    });
  }

  function closeModal(value) {
    const el = $('#modal');
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    if (modalResolve) {
      const r = modalResolve;
      modalResolve = null;
      r(!!value);
    }
  }

  /* 居中放大面板：表格命中行提取后铺满屏幕中央，看完可关掉 */
  function openRowPanel(title, html, eyebrow) {
    const el = document.getElementById('rowPanel');
    if (!el) return;
    const t = document.getElementById('rowPanelTitle');
    const e = document.getElementById('rowPanelEyebrow');
    const b = document.getElementById('rowPanelBody');
    if (t) t.textContent = title || '表格命中行';
    if (e) e.textContent = eyebrow || '表格命中行';
    if (b) b.innerHTML = html || '';
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeRowPanel() {
    const el = document.getElementById('rowPanel');
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
  }

  function rowPanelOpen() {
    const el = document.getElementById('rowPanel');
    return !!(el && el.classList.contains('open'));
  }

  /* 把 { head:[], rows:[[]], query:'' } 渲染成一张横向表格：
     表头与每个单元格都按列对齐，命中词包 <mark>。 */
  function rowTableHtml(data) {
    const d = data || {};
    const head = d.head || [];
    const rows = d.rows || [];
    const query = String(d.query || '').trim();
    const cols = Math.max(head.length, rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0));
    if (!cols) return '<div class="rp-empty">这一行没有可显示的单元格</div>';
    const mark = function (v) {
      const s = esc(v);
      if (!query) return s;
      const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try { return s.replace(new RegExp('(' + q + ')', 'gi'), '<mark class="kw-hit">$1</mark>'); }
      catch (e) { return s; }
    };
    let out = '<div class="rp-scroll"><table class="rp-table"><thead><tr>';
    out += '<th class="rp-idx">#</th>';
    for (let c = 0; c < cols; c++) out += '<th>' + (head[c] ? mark(head[c]) : '—') + '</th>';
    out += '</tr></thead><tbody>';
    rows.forEach(function (r, i) {
      out += '<tr><td class="rp-idx">' + (i + 1) + '</td>';
      for (let c = 0; c < cols; c++) out += '<td>' + (r[c] ? mark(r[c]) : '') + '</td>';
      out += '</tr>';
    });
    return out + '</tbody></table></div>';
  }

  /* 进度 */
  function progress(show, percent, text) {
    const el = $('#progress');
    const bar = $('#progressBar').firstElementChild;
    const label = $('#progressText');
    if (!el) return;
    if (!show) {
      el.classList.remove('on');
      return;
    }
    el.classList.add('on');
    if (bar) bar.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
    if (label) label.textContent = text || '';
  }

  /* 完成反馈内容 */
  function resultHtml(ok, title, desc) {
    return '<div class="result">' +
      '<div class="ring' + (ok ? '' : ' danger') + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (ok ? 'M5 12.5l4.5 4.5L19 7' : 'M7 7l10 10M17 7L7 17') + '" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(desc || '') + '</p>' +
      '</div>';
  }

  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-close-drawer]');
    if (t) { closeDrawer(); return; }
    const m = e.target.closest('[data-close-modal]');
    if (m) { closeModal(false); return; }
    if (e.target.closest('[data-close-rowpanel]')) { closeRowPanel(); return; }
    const btn = e.target.closest('[data-modal]');
    if (btn) { closeModal(btn.getAttribute('data-modal') === 'ok'); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (rowPanelOpen()) { closeRowPanel(); return; }
      if ($('#modal').classList.contains('open')) { closeModal(false); return; }
      if ($('#drawer').classList.contains('open')) closeDrawer();
    }
  });

  window.UI = {
    $: $, $$: $$,
    esc: esc,
    fmtSize: fmtSize,
    fmtDate: fmtDate,
    monthLabel: monthLabel,
    icon: icon,
    kindIcon: kindIcon,
    toast: toast,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    onDrawerClose: onDrawerClose,
    confirm: confirmBox,
    closeModal: closeModal,
    openRowPanel: openRowPanel,
    closeRowPanel: closeRowPanel,
    rowPanelOpen: rowPanelOpen,
    rowTableHtml: rowTableHtml,
    progress: progress,
    resultHtml: resultHtml,
    celebrate: celebrate
  };
})();
