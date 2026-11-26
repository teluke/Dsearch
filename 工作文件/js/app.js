/* 应用启动、路由与全局交互 */

(function () {
  window.APP_VERSION = '2.18.0';
  const $ = UI.$;
  const $$ = UI.$$;
  const TABS = ['home', 'schedule', 'archive', 'records', 'stats', 'events', 'search', 'settings'];
  const TAB_TITLES = {
    home: '工作文件',
    schedule: '课表',
    archive: '文件归档',
    records: '文档记录',
    stats: '文档统计',
    events: '事件',
    search: '信息查询',
    settings: '个人设置'
  };

  function tabFromHash() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    return TABS.indexOf(h) >= 0 ? h : 'home';
  }

  /* 左侧导航抽屉 */
  function navDrawer() { return $('#navDrawer'); }

  function openNav() {
    const el = navDrawer();
    if (!el) return;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    $('#menuBtn').setAttribute('aria-expanded', 'true');
  }

  function closeNav() {
    const el = navDrawer();
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    $('#menuBtn').setAttribute('aria-expanded', 'false');
  }

  async function switchTab(tab, updateHash) {
    if (TABS.indexOf(tab) < 0) tab = 'home';
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.getAttribute('data-tab') === tab); });
    $$('.nav-item').forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === tab); });
    const title = $('#appTitle');
    if (title) title.textContent = TAB_TITLES[tab] || '工作文件';
    const grp = document.getElementById('navGroupArchive');
    const fold = document.querySelector('[data-nav-fold="archive"]');
    if (grp && fold) {
      const open = tab === 'records';
      grp.classList.toggle('open', open);
      fold.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    closeNav();
    if (updateHash) {
      const target = '#/' + tab;
      if (location.hash !== target) history.replaceState(null, '', target);
    }
    window.scrollTo(0, 0);
    closeFab();
    if (tab === 'events') setEventsBadge(0);
    await Views.go(tab);
  }

  /* 事件提醒：临近截止或逾期时打角标、每天弹一次提示 */
  function setEventsBadge(n) {
    const item = document.querySelector('.nav-item[data-tab="events"]');
    if (item) item.classList.toggle('alert', n > 0);
  }

  async function updateEventsAlerts(allowToast) {
    try {
      const docs = await DB.allDocuments();
      const series = await DB.listSeries();
      const events = Events.compute(docs, series, DB.todayISO());
      const alerting = events.filter(function (ev) { return ev.status === 'overdue' || ev.remind; });
      if (Views.state.tab === 'events') { setEventsBadge(0); return; }
      setEventsBadge(alerting.length);
      if (!allowToast || !alerting.length) return;
      const today = DB.todayISO();
      const last = await DB.getSetting('eventsLastRemind', '');
      if (last === today) return;
      await DB.setSetting('eventsLastRemind', today);
      const over = alerting.filter(function (ev) { return ev.status === 'overdue'; });
      const soon = alerting.length - over.length;
      let msg = '';
      if (soon) msg += soon + ' 个事件临近截止';
      if (over.length) msg += (msg ? '，' : '') + over.length + ' 个事件已逾期';
      UI.toast('提醒：' + msg + '，可在「事件」页查看', over.length ? 'err' : '');
    } catch (e) { /* 忽略 */ }
  }

  /* 悬浮菜单 */
  let fabMask = null;

  function ensureMask() {
    if (fabMask) return fabMask;
    fabMask = document.createElement('div');
    fabMask.className = 'fab-mask';
    fabMask.addEventListener('click', function () { closeFab(); });
    document.body.appendChild(fabMask);
    return fabMask;
  }

  function openFab() {
    const wrap = $('#fabWrap');
    if (!wrap) return;
    wrap.classList.add('open');
    ensureMask().classList.add('on');
    $('#fab').setAttribute('aria-expanded', 'true');
  }

  function closeFab() {
    const wrap = $('#fabWrap');
    if (!wrap) return;
    wrap.classList.remove('open');
    if (fabMask) fabMask.classList.remove('on');
    const fab = $('#fab');
    if (fab) fab.setAttribute('aria-expanded', 'false');
  }

  function bindFab() {
    const fab = $('#fab');
    const wrap = $('#fabWrap');
    if (!fab || !wrap) return;

    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      if (wrap.classList.contains('open')) closeFab();
      else openFab();
    });

    wrap.querySelectorAll('[data-fab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const kind = btn.getAttribute('data-fab');
        closeFab();
        if (kind === 'file') {
          const picker = $('#filePicker');
          picker.value = '';
          picker.click();
        } else if (kind === 'camera') {
          const picker = $('#cameraPicker');
          picker.value = '';
          picker.click();
        } else if (kind === 'template') {
          Views.openSeriesForm(null);
        }
      });
    });
  }

  /* 全局搜索栏：任何界面常驻顶部，输入即进入查询并实时出结果 */
  function bindGlobalSearch() {
    const input = $('#globalSearch');
    const clearBtn = $('#globalSearchClear');
    if (!input) return;

    let timer = null;
    input.addEventListener('input', function () {
      if (clearBtn) clearBtn.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(async function () {
        if (input.value === Views.state.search.q) return;
        await Views.setSearchQuery(input.value);
        /* 跳到查询页后保持焦点，继续输入不中断 */
        if (document.activeElement !== input) {
          try { input.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
        }
      }, 280);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        Views.setSearchQuery(input.value);
        input.blur();
      }
    });
    input.addEventListener('search', function () {
      /* 点输入框的 × 清空（部分浏览器触发 search 事件） */
      if (!input.value) {
        clearTimeout(timer);
        Views.setSearchQuery('');
        if (clearBtn) clearBtn.hidden = true;
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        clearBtn.hidden = true;
        clearTimeout(timer);
        Views.setSearchQuery('');
        input.focus();
      });
    }
  }

  /* 触屏设备：折叠菜单里的扫码入口直接进手机扫码流程 */
  function isTouchDevice() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  /* 局域网连接期间：手机收到电脑推送后自动刷新（备忘录与统计信息实时更新） */
  let remoteTimer = null;

  function remoteRefreshAllowed() {
    if ($('#drawer').classList.contains('open')) return false;
    if ($('#modal').classList.contains('open')) return false;
    if ($('#viewer').classList.contains('open')) return false;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false;
    return true;
  }

  function scheduleRemoteRefresh() {
    if (remoteTimer) return;
    remoteTimer = setTimeout(async function () {
      remoteTimer = null;
      if (!remoteRefreshAllowed()) return;
      try {
        await Views.refresh();
        updateEventsAlerts(false);
      } catch (e) { /* 忽略 */ }
    }, 600);
  }

  function bindRemoteSync() {
    if (!window.Sync || window.Sync.__appBound) return;
    window.Sync.__appBound = true;
    ['remote-doc', 'remote-memos', 'remote-series', 'remote-folders'].forEach(function (name) {
      window.Sync.on(name, scheduleRemoteRefresh);
    });
  }

  function bindPickers() {    const filePicker = $('#filePicker');
    filePicker.addEventListener('change', function () {
      const files = Array.prototype.slice.call(filePicker.files || []);
      filePicker.value = '';
      if (files.length) Views.handleFiles(files);
    });

    const cameraPicker = $('#cameraPicker');
    cameraPicker.addEventListener('change', function () {
      const files = Array.prototype.slice.call(cameraPicker.files || []);
      cameraPicker.value = '';
      if (files.length) Views.handleFiles(files);
    });

    const backupPicker = $('#backupPicker');
    backupPicker.addEventListener('change', function () {
      const file = backupPicker.files && backupPicker.files[0];
      backupPicker.value = '';
      if (file) Views.doImport(file);
    });
  }

  /* 拖拽归档（电脑端） */
  function bindDrop() {
    let depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      depth++;
      document.body.style.outline = '2px dashed #6C8BF5';
      document.body.style.outlineOffset = '-10px';
    });
    window.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        document.body.style.outline = '';
        document.body.style.outlineOffset = '';
      }
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      document.body.style.outline = '';
      document.body.style.outlineOffset = '';
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) Views.handleFiles(files);
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      /* 新版本 Service Worker 激活后提醒刷新，避免两端版本不一致 */
      reg.addEventListener('updatefound', function () {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'activated' && navigator.serviceWorker.controller && window.UI) {
            UI.toast('应用已更新，建议刷新页面以启用最新功能', 'warn');
          }
        });
      });
    }).catch(function (err) {
      console.warn('[SW] 注册失败', err);
    });
  }

  /* 后台自动补提取正文：空闲时逐个处理还没提取的文档，让全文搜索能直接命中。
     每次启动最多处理 24 份，逐份进行，避免卡顿；图片走 OCRJob，不在这里处理 */
  async function autoExtractBacklog() {
    if (!window.Parser || !window.DB) return;
    try {
      const docs = await DB.allDocuments();
      const TEXT_EXT = Parser.TEXT_EXT || [];
      const todo = docs.filter(function (d) {
        if (!d.blob || d.extractStatus === 'done' || d.extractStatus === 'skipped') return false;
        if (Parser.kindOf(d.name || '') === 'image') return false; /* 图片类由 OCR 任务负责 */
        const ext = Parser.extOf(d.name || '');
        const kind = Parser.kindOf(d.name || '');
        return ext === 'docx' || ext === 'csv' || ext === 'xlsx' ||
          TEXT_EXT.indexOf(ext) >= 0 || kind === 'pdf';
      }).slice(0, 24);

      let extracted = 0;
      for (let i = 0; i < todo.length; i++) {
        const d = todo[i];
        try {
          const pseudo = { name: d.name, arrayBuffer: function () { return d.blob.arrayBuffer(); } };
          const parsed = await Parser.extractText(pseudo);
          if (parsed && parsed.status === 'done' && parsed.text) {
            await DB.updateDocument(d.id, { fullText: parsed.text, extractStatus: 'done' });
            extracted++;
          } else {
            await DB.updateDocument(d.id, { extractStatus: 'skipped' });
          }
        } catch (e) { /* 单份失败不阻断 */ }
      }
      if (extracted > 0 && window.Views && Views.state.tab === 'search') {
        await window.App.refresh();
      }
    } catch (e) { /* 后台任务失败静默 */ }
  }

  /* 光标聚光灯：跟随鼠标/触点，并从背景照片对应位置取色 */
  function bindSpotlight() {
    const root = document.documentElement;
    let raf = 0, x = -999, y = -999, touchTimer = 0, iw = 0, ih = 0;
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 64;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const bg = new Image();
    bg.onload = function () {
      iw = bg.naturalWidth;
      ih = bg.naturalHeight;
      if (ctx) ctx.drawImage(bg, 0, 0, cv.width, cv.height);
    };
    bg.src = 'assets/bg-jade.jpg';

    /* background-size: cover 的反向映射，取当前落点下方照片的颜色 */
    function sample(px, py) {
      if (!ctx || !iw || !ih) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const scale = Math.max(vw / iw, vh / ih);
      const ox = (vw - iw * scale) / 2, oy = (vh - ih * scale) / 2;
      const ix = Math.round((px - ox) / scale / iw * cv.width);
      const iy = Math.round((py - oy) / scale / ih * cv.height);
      if (ix < 0 || iy < 0 || ix >= cv.width || iy >= cv.height) return;
      let d;
      try { d = ctx.getImageData(ix, iy, 1, 1).data; } catch (e) { return; }
      /* 先提饱和再往白色提亮，颜色可见但不压低文字对比度 */
      const lum = (d[0] + d[1] + d[2]) / 3, sat = 1.7;
      const mix = function (v) {
        const s = Math.max(0, Math.min(255, lum + (v - lum) * sat));
        return Math.round(s * .55 + 255 * .45);
      };
      const r = mix(d[0]), g = mix(d[1]), b = mix(d[2]);
      root.style.setProperty('--spot-rgb', r + ', ' + g + ', ' + b);
    }
    function apply() {
      raf = 0;
      root.style.setProperty('--spot-x', x + 'px');
      root.style.setProperty('--spot-y', y + 'px');
      sample(x, y);
    }
    function move(e) {
      const p = e.touches && e.touches.length ? e.touches[0] : e;
      if (!p || typeof p.clientX !== 'number') return;
      x = p.clientX;
      y = p.clientY;
      root.classList.add('spot-on');
      if (!raf) raf = requestAnimationFrame(apply);
      if (e.type === 'touchstart' || e.type === 'touchmove') {
        clearTimeout(touchTimer);
        touchTimer = setTimeout(function () { root.classList.remove('spot-on'); }, 1800);
      }
    }
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('touchstart', move, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', function () {
      clearTimeout(touchTimer);
      touchTimer = setTimeout(function () { root.classList.remove('spot-on'); }, 900);
    }, { passive: true });
    document.addEventListener('mouseleave', function () { root.classList.remove('spot-on'); });
  }

  async function boot() {
    bindSpotlight();
    try {
      await DB.initSettings();
    } catch (err) {
      console.warn('[DB] 初始化失败', err);
      UI.toast('本地数据库不可用，请检查浏览器隐私设置', 'err');
    }

    $$('.nav-item').forEach(function (t) {
      t.addEventListener('click', function () {
        const tab = t.getAttribute('data-tab');
        if (tab === Views.state.tab && document.querySelector('.view.active')) { closeNav(); return; }
        switchTab(tab, true);
      });
    });

    $$('[data-nav-fold]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const grp = document.getElementById('navGroupArchive');
        if (!grp) return;
        const open = !grp.classList.contains('open');
        grp.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });

    const menuBtn = $('#menuBtn');
    if (menuBtn) {
      menuBtn.addEventListener('click', function () {
        if (navDrawer().classList.contains('open')) closeNav();
        else openNav();
      });
    }

    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-close-nav]')) closeNav();
    });

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navDrawer().classList.contains('open')) closeNav();
    });

    bindFab();
    bindPickers();

    /* 折叠菜单里的扫码入口（个人设置下方） */
    const navSync = $('#navSync');
    if (navSync) {
      navSync.addEventListener('click', function () {
        closeNav();
        if (window.SyncUI) window.SyncUI.open({ scan: isTouchDevice() });
        else UI.toast('同步组件未加载');
      });
    }
    bindRemoteSync();

    bindGlobalSearch();
    bindDrop();
    registerSW();

    window.addEventListener('hashchange', function () {
      const tab = tabFromHash();
      if (tab !== Views.state.tab) switchTab(tab, false);
    });

    window.addEventListener('resize', function () {
      const chips = $$('[data-chips]');
      chips.forEach(function (wrap) {
        const bg = wrap.querySelector('.chip-bg');
        const on = wrap.querySelector('.chip.on');
        if (bg && on) {
          bg.style.left = on.offsetLeft + 'px';
          bg.style.width = on.offsetWidth + 'px';
        }
      });
    });

    await switchTab(tabFromHash(), false);

    /* 上次识别被刷新打断时接着做完（不阻塞首屏） */
    if (window.OCRJob) {
      setTimeout(function () {
        OCRJob.resumePending().catch(function () { /* 忽略 */ });
      }, 2500);
    }

    /* 空闲后自动补提取正文，扩充全文搜索覆盖面 */
    setTimeout(function () { autoExtractBacklog(); }, 4000);

    const docs = await DB.allDocuments();
    if (!docs.length) {
      setTimeout(function () {
        UI.toast('点右下角加号，选取文件或拍照归档');
      }, 700);
    } else {
      setTimeout(function () { updateEventsAlerts(true); }, 900);
    }
  }

  window.App = {
    switchTab: switchTab,
    updateEventsAlerts: updateEventsAlerts,
    refresh: async function () {
      await Views.refresh();
      updateEventsAlerts(false);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
