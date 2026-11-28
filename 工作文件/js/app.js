/* 应用启动、路由与全局交互 */

(function () {
  window.APP_VERSION = '2.39.0';
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
    el.classList.remove('sub-open');
    el.setAttribute('aria-hidden', 'true');
    $('#menuBtn').setAttribute('aria-expanded', 'false');
    setSub(false);
  }

  /* 文件归档的二级抽屉（v2.27：原来是把子项摊在列表里，会撑出一块空白） */
  function openSub() {
    const el = navDrawer();
    if (!el) return;
    el.classList.add('sub-open');
    setSub(true);
  }

  function setSub(open) {
    const sub = document.getElementById('navSubArchive');
    if (sub) sub.setAttribute('aria-hidden', open ? 'false' : 'true');
    const fold = document.querySelector('[data-nav-sub="archive"]');
    if (fold) fold.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* iOS 式页面切换：先把目标页渲染完再放出来。
     动画只推 transform，绝不动整页 opacity —— 页面本身透明，淡入时亮天空会透上来，
     看起来就是背景爆闪；推入期间始终由一张不透明的完整页面盖住背景。 */
  function playViewPush(target, forward) {
    if (!target || !target.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    target.classList.remove('view-waiting');
    target.classList.add('view-slide');
    const anim = target.animate([
      { transform: 'translate3d(' + (forward ? 20 : -20) + 'px, 0, 0)' },
      { transform: 'translate3d(0, 0, 0)' }
    ], { duration: 260, easing: 'cubic-bezier(.22, .8, .24, 1)' });
    anim.finished.then(function () { target.classList.remove('view-slide'); })
      .catch(function () { target.classList.remove('view-slide'); });
  }

  /* 切页串行化：连点时若上一个 Views.go() 还在 await，后一次切页必须排在后面，
     否则旧任务会在新任务之后把旧页重新标成 active，出现空档和闪白。 */
  let navQueue = Promise.resolve();
  let desiredTab = null;

  function switchTab(tab, updateHash) {
    if (TABS.indexOf(tab) < 0) tab = 'home';
    desiredTab = tab;
    const job = navQueue.then(function () { return switchTabNow(tab, updateHash); });
    navQueue = job.catch(function () { /* 单次失败不阻塞后续导航 */ });
    return job;
  }

  async function switchTabNow(tab, updateHash) {
    if (TABS.indexOf(tab) < 0) tab = 'home';
    desiredTab = tab;
    const oldView = document.querySelector('.view.active');
    const oldTab = oldView ? oldView.getAttribute('data-tab') : null;
    const target = document.querySelector('.view[data-tab="' + tab + '"]');
    const changed = !!oldView && oldTab !== tab;
    /* v2.34：渲染期间旧页继续显示，目标页移到文档流外隐藏渲染。
       旧版先把旧页撤掉再等新页渲染，中间两页都不在画面里，只剩亮天空，
       看起来就是切页时背景爆闪。 */
    if (changed && target) target.classList.add('view-waiting');
    $$('.nav-item').forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === tab); });
    const title = $('#appTitle');
    if (title) title.textContent = TAB_TITLES[tab] || '工作文件';
    /* 搜索栏只留在主页：其余页面收成右上角一个图标，点了直接进「信息查询」，
       那一页有自己的输入框，不再靠顶栏常驻 */
    const isHome = tab === 'home';
    const gs = document.querySelector('.global-search');
    const abSearch = $('#appbarSearch');
    if (gs) gs.hidden = !isHome;
    if (abSearch) abSearch.hidden = isHome || tab === 'search';
    const grp = document.getElementById('navGroupArchive');
    if (grp) grp.classList.toggle('open', tab === 'records' || tab === 'archive');
    closeNav();
    if (updateHash) {
      const targetHash = '#/' + tab;
      if (location.hash !== targetHash) history.replaceState(null, '', targetHash);
    }
    closeFab();
    if (tab === 'events') setEventsBadge(0);
    try {
      await Views.go(tab);
    } finally {
      if (target) target.classList.remove('view-waiting');
    }
    /* 新内容就绪后才换页，滚动位置也在这里归零，用户看不到中间的空白帧 */
    if (changed && oldView) oldView.classList.remove('active');
    if (target) target.classList.add('active');
    window.scrollTo(0, 0);
    if (changed) playViewPush(target, TABS.indexOf(tab) >= TABS.indexOf(oldTab));
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

  /* 光标聚光灯：背景层里的一团柔光跟着指针走。
     只写一次 transform，走合成器；不改 CSS 变量，避免整棵树重算样式。
     触屏上抬手 900ms 后淡出，不长期占用一层发光。 */
  function bindSkyLight() {
    const el = document.getElementById('skyLight');
    if (!el) return;
    const R = 280;
    let raf = 0, x = 0, y = 0, timer = 0;
    function apply() {
      raf = 0;
      el.style.transform = 'translate3d(' + Math.round(x - R) + 'px,' + Math.round(y - R) + 'px,0)';
    }
    function move(e) {
      const p = e.touches && e.touches.length ? e.touches[0] : e;
      if (!p || typeof p.clientX !== 'number') return;
      x = p.clientX;
      y = p.clientY;
      if (!el.classList.contains('on')) el.classList.add('on');
      if (!raf) raf = requestAnimationFrame(apply);
      if (e.pointerType && e.pointerType !== 'mouse') {
        clearTimeout(timer);
        timer = setTimeout(function () { el.classList.remove('on'); }, 900);
      }
    }
    function hide() {
      clearTimeout(timer);
      el.classList.remove('on');
    }
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', move, { passive: true });
    document.addEventListener('mouseleave', hide);
    window.addEventListener('blur', hide);
  }

  /* 雨雪 / 云层视差：指针位置换算成 -1..1 写进 .sky 的 --wx / --wy，
     雨丝、雪花、三层云各按远近乘不同幅度偏移。写在天空根节点上，
     子层直接继承，一次 rAF 一帧，真正动的只是合成器里的 translate。
     云层取负号（与指针反向），近层 4px、远层 2px，天空就有纵深。 */
  function bindSkyParallax() {
    const el = document.getElementById('sky');
    if (!el) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0, tx = 0, ty = 0;
    function apply() {
      raf = 0;
      el.style.setProperty('--wx', tx.toFixed(3));
      el.style.setProperty('--wy', ty.toFixed(3));
    }
    function put() { if (!raf) raf = requestAnimationFrame(apply); }
    function move(e) {
      if (!e || typeof e.clientX !== 'number' || !window.innerWidth || !window.innerHeight) return;
      tx = (e.clientX / window.innerWidth) * 2 - 1;
      ty = (e.clientY / window.innerHeight) * 2 - 1;
      put();
    }
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('mouseleave', function () { tx = 0; ty = 0; put(); });
    window.addEventListener('blur', function () { tx = 0; ty = 0; put(); });
  }

  /* v2.37 滚动冻结：滚动期间暂停天空所有 CSS 动画，停手 180ms 后恢复。
     移动端 Safari 滚动时会重绘 fixed 合成层，正在跑的云漂移/浮动/雨雪
     会让背景爆闪一下。只切 animation-play-state —— 动画停在当前时刻，
     恢复后从原处继续，云不会跳帧；视差变量照常更新，纵深仍然跟手。
     capture:true 连抽屉、弹窗里的内部滚动也覆盖。 */
  function bindSkyFreeze() {
    let timer = 0;
    let frozen = false;
    function thaw() {
      if (!frozen) return;
      frozen = false;
      document.documentElement.classList.remove('sky-scrolling');
    }
    function freeze() {
      if (!frozen) {
        frozen = true;
        document.documentElement.classList.add('sky-scrolling');
      }
      clearTimeout(timer);
      timer = setTimeout(thaw, 180);
    }
    window.addEventListener('scroll', freeze, { capture: true, passive: true });
    window.addEventListener('touchmove', freeze, { passive: true });
    window.addEventListener('wheel', freeze, { passive: true });
    window.addEventListener('touchend', function () {
      clearTimeout(timer);
      timer = setTimeout(thaw, 180);
    }, { passive: true });
  }

  /* 时段标记：影子长度按太阳高度走（早长 → 正午短 → 傍晚再拉长），
     只写一个 data-daypart，天空层用 CSS 变量接住，十分钟校一次。 */
  function daypartOf(h) {
    if (h >= 5 && h < 9) return 'morning';
    if (h >= 9 && h < 14) return 'midday';
    if (h >= 14 && h < 17) return 'afternoon';
    if (h >= 17 && h < 20) return 'evening';
    return 'night';
  }

  function markDaypart() {
    const root = document.documentElement;
    const put = function () { root.setAttribute('data-daypart', daypartOf(new Date().getHours())); };
    put();
    setInterval(put, 10 * 60 * 1000);
  }

  /* 按下水晶按键的触感：手机端给 8ms 轻振，桌面端浏览器没有 vibrate，自然为空 */
  let hapticsOn = true;
  const HAPTIC_SEL = '.btn,.icon-btn,.chip,.kw-chip,.wk-chip,.sw-day,.sh-week,.ft-btn,' +
    '.nav-item,.nav-fold,.nav-qr,.section-link,.fab,.fab-sub,.memo-act,.memo-add-btn,' +
    '.fchip,.kw-btn,.kw-fold-head';

  function bindHaptics() {
    if (!navigator.vibrate) return;
    document.addEventListener('pointerdown', function (e) {
      if (!hapticsOn) return;
      if (!e.target || !e.target.closest) return;
      if (!e.target.closest(HAPTIC_SEL)) return;
      try { navigator.vibrate(8); } catch (err) { /* 部分浏览器要求用户手势，忽略 */ }
    }, { passive: true });
  }

  async function boot() {
    bindSkyLight();
    bindSkyParallax();
    bindSkyFreeze();
    markDaypart();
    bindHaptics();
    try {
      hapticsOn = (await DB.getSetting('haptics', true)) !== false;
    } catch (e) { hapticsOn = true; }
    try {
      await DB.initSettings();
    } catch (err) {
      console.warn('[DB] 初始化失败', err);
      UI.toast('本地数据库不可用，请检查浏览器隐私设置', 'err');
    }

    /* 背景形态跟着当天天气走；不等网络，失败静默 */
    if (window.Weather) {
      try { await Weather.init(); } catch (e) { /* 忽略 */ }
    }

    $$('.nav-item').forEach(function (t) {
      t.addEventListener('click', function () {
        const tab = t.getAttribute('data-tab');
        const active = document.querySelector('.view.active');
        /* 不比 Views.state.tab：它在 Views.go() 开头就改了，排队中的切页会被误判成「当前页」 */
        if (tab === (active ? active.getAttribute('data-tab') : null)) { closeNav(); return; }
        switchTab(tab, true);
      });
    });

    $$('[data-nav-sub="archive"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openSub();
      });
    });
    $$('[data-nav-sub-back]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const el = navDrawer();
        if (el) el.classList.remove('sub-open');
        setSub(false);
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
    const abSearch = $('#appbarSearch');
    if (abSearch) {
      abSearch.addEventListener('click', function () {
        switchTab('search', true).then(function () {
          const input = document.querySelector('#view-search #pageSearch');
          if (input) { try { input.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }
        });
      });
    }
    bindDrop();
    registerSW();

    window.addEventListener('hashchange', function () {
      const tab = tabFromHash();
      const active = document.querySelector('.view.active');
      const current = active ? active.getAttribute('data-tab') : null;
      if (tab !== current && tab !== desiredTab) switchTab(tab, false);
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
    setHaptics: function (on) { hapticsOn = on !== false; },
    setWeatherBg: async function (on) {
      if (window.Weather) await Weather.setEnabled(on);
    },
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
