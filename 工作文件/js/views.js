/* 五个模块的视图渲染与交互 */

(function () {
  const $ = UI.$;
  const $$ = UI.$$;
  const esc = UI.esc;

  const state = {
    tab: 'home',
    archive: { month: 'all', sort: 'archive', visible: 60, folder: 'all', multi: false, picked: [] },
    records: { filter: 'all', visible: 80 },
    stats: { seriesId: null },
    events: { seriesId: null, seg: 'cycle', visible: 100 },
    search: { q: '', seriesId: null, ext: null, filterWords: [] },
    home: { day: '' },
    memoEditId: null,
    docs: [],
    series: [],
    folders: [],
    /* 文件夹折叠状态：v2.4.2 起改为「进入文件夹看子文件夹」，折叠逻辑退役 */
    folderFold: {},
    kwPinned: []
  };

  const KIND_LABEL = { doc: '文档', sheet: '表格', pdf: 'PDF', image: '图片', other: '文件' };

  /* 全局搜索栏清空按钮的显隐 */
  function syncGlobalClear() {
    const g = document.getElementById('globalSearch');
    const c = document.getElementById('globalSearchClear');
    if (g && c) c.hidden = !g.value;
  }

  async function loadAll() {
    state.docs = await DB.allDocuments();
    state.series = await DB.listSeries();
    try { state.folders = await DB.listFolders(); } catch (e) { state.folders = []; }
    try { state.kwPinned = (await DB.getSetting('kwPinned', [])) || []; } catch (e) { state.kwPinned = []; }
    try { state.search.filterWords = (await DB.getSetting('searchFilterWords', [])) || []; } catch (e) { state.search.filterWords = []; }
  }

  function folderById(id) {
    for (let i = 0; i < state.folders.length; i++) {
      if (state.folders[i].id === id) return state.folders[i];
    }
    return null;
  }

  function folderName(id) {
    const f = folderById(id);
    return f ? f.name : '';
  }

  /* ---------- 文件夹层级（子文件夹） ---------- */

  function folderKids(pid) {
    return state.folders.filter(function (f) { return (f.parentId || null) === (pid || null); });
  }

  /* 树序平铺：[{ f, depth }]，按创建时间排序，子级紧跟父级 */
  function orderedFolders() {
    const out = [];
    function walk(pid, depth) {
      folderKids(pid).forEach(function (f) {
        out.push({ f: f, depth: depth });
        walk(f.id, depth + 1);
      });
    }
    walk(null, 0);
    /* 新建的文件夹若因 parent 丢失而没被走到，补在末尾防止「消失」 */
    state.folders.forEach(function (f) {
      const hit = out.filter(function (o) { return o.f.id === f.id; })[0];
      if (!hit) out.push({ f: f, depth: 0 });
    });
    return out;
  }

  /* 完整路径名，如 「期末材料 / 试卷」；top 只取名字 */
  function folderPath(id, sep) {
    const parts = [];
    let cur = folderById(id);
    let guard = 0;
    while (cur && guard++ < 10) { parts.unshift(cur.name); cur = cur.parentId ? folderById(cur.parentId) : null; }
    return parts.join(sep || ' / ');
  }

  /* 路径链：从顶层到该文件夹的 id 数组，面包屑跳转用 */
  function folderChainIds(id) {
    const ids = [];
    let cur = folderById(id);
    let guard = 0;
    while (cur && guard++ < 10) { ids.unshift(cur.id); cur = cur.parentId ? folderById(cur.parentId) : null; }
    return ids;
  }

  /* 递归计数：文件夹内的文件 + 所有子文件夹里的文件（Windows 式含子级） */
  function folderDeepCount(fid) {
    let n = state.docs.filter(function (d) { return String(d.folderId) === String(fid); }).length;
    folderKids(fid).forEach(function (k) { n += folderDeepCount(k.id); });
    return n;
  }

  function isDescendantFolder(id, maybeAncestor) {
    let cur = folderById(id);
    let guard = 0;
    while (cur && cur.parentId && guard++ < 10) {
      if (cur.parentId === maybeAncestor) return true;
      cur = folderById(cur.parentId);
    }
    return false;
  }

  /* ---------- 标题自动归档：文件名里含文件夹名就自动放入 ---------- */
  function matchFolderByName(title) {
    const t = String(title || '').toLowerCase();
    if (!t) return null;
    let best = null;
    let bestLen = 0;
    state.folders.forEach(function (f) {
      const n = String(f.name || '').toLowerCase().trim();
      /* 名字太短（单字）容易误配，至少两个字才参与自动匹配 */
      if (n.length < 2 || n.length <= bestLen) return;
      if (t.indexOf(n) >= 0) { best = f; bestLen = n.length; }
    });
    return best ? best.id : null;
  }

  /* ---------- 子文件夹悬浮面板（已退役，v2.4.2 改为进入文件夹内显示） ---------- */

  function seriesById(id) {
    for (let i = 0; i < state.series.length; i++) {
      if (state.series[i].id === id) return state.series[i];
    }
    return null;
  }

  function seriesName(id) {
    const s = seriesById(id);
    return s ? s.name : '';
  }

  function monthsOf(docs, sortKey) {
    const set = {};
    docs.forEach(function (d) {
      const m = (sortKey === 'fileDate' ? (d.fileDate || d.archiveDate || '') : (d.archiveDate || '')).slice(0, 7);
      if (m) set[m] = true;
    });
    return Object.keys(set).sort().reverse();
  }

  function isAbnormal(d) {
    if (!d.fileDate) return true;
    if (d.archiveDate && d.fileDate > d.archiveDate) return true;
    return false;
  }

  function typeBadge(kind) {
    return '<span class="badge muted">' + (KIND_LABEL[kind] || '文件') + '</span>';
  }

  /* 文件名里读到的序号：只有显式写出来的（第3次 / (2) / -04）才展示 */
  function seqBadgeHtml(d) {
    if (d.seq == null || !d.seqTag) return '';
    return '<span class="badge muted">' + esc(d.seqTag) + '</span>';
  }

  /* 图片的文字识别状态（识别中 / 已识别 N 字 / 无文字 / 失败） */
  function ocrBadgeHtml(d) {    const st = d.ocrStatus || 'none';
    if (st === 'done') {
      const n = d.ocrChars || (d.ocrText || '').length;
      return '<span class="badge ocr">文字 ' + n + ' 字</span>';
    }
    if (st === 'pending') return '<span class="badge muted ocr-pending">识别中</span>';
    if (st === 'failed') return '<span class="badge muted">未识别</span>';
    if (st === 'empty') return '<span class="badge muted">无文字</span>';
    return '';
  }

  /* 归档一份图片后，按开关自动排进文字识别队列 */
  async function queueOcrFor(id, name) {
    if (!id || !window.OCRJob) return;
    if (Parser.kindOf(name || '') !== 'image') return;
    const st = await OCRJob.loadSettings();
    if (!st.enabled) return;
    OCRJob.enqueue(id);
  }

  function emptyBlock(title, desc) {
    return '<div class="empty">' +
      '<div class="glyph">' + UI.icon('folder') + '</div>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(desc) + '</p>' +
      '</div>';
  }

  /* ---------- 主页 ---------- */

  function weekDateLabel() {
    const d = new Date();
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + wd;
  }

  function sectionLink(tab) {
    return '<button class="section-link" data-nav="' + tab + '" type="button">全部' + UI.icon('chev') + '</button>';
  }

  /* ---------- 待办标签：时间 / 地点 / 事件 ---------- */

  /* 常见地点后缀：命中即认为这句话里带了地点 */
  const PLACE_WORDS = ['会议室', '阶梯教室', '教室', '办公室', '报告厅', '录播室', '多功能厅', '活动室',
    '机房', '实验室', '图书馆', '体育馆', '操场', '礼堂', '食堂', '大厅', '腾讯会议', '钉钉会议', '线上'];

  /* 事件类型：从标题里做一次轻量归纳，让「事件」标签有内容可看 */
  const KIND_RULES = [
    ['教研', ['教研', '备课', '磨课', '公开课', '说课', '课题']],
    ['听课', ['听课', '评课', '观摩']],
    ['会议', ['会议', '开会', '例会', '研讨', '座谈', '组会']],
    ['培训', ['培训', '讲座', '进修', '学习']],
    ['考试', ['考试', '测验', '监考', '月考', '期中', '期末']],
    ['作业', ['作业', '批改']],
    ['活动', ['活动', '运动会', '班会', '家访', '比赛', '演出', '值日', '值班']],
    ['材料', ['材料', '申报', '报告', '总结', '表格', '填报', '汇总']]
  ];

  function pad2(n) { n = parseInt(n, 10) || 0; return (n < 10 ? '0' : '') + n; }

  function to24(h, ap) {
    let n = parseInt(h, 10);
    if (ap === '下午' || ap === '傍晚' || ap === '晚上') { if (n < 12) n += 12; }
    else if (ap === '中午') { if (n < 11) n += 12; }
    return Math.max(0, Math.min(23, n));
  }

  function eventKindOf(text) {
    const s = String(text || '');
    for (let i = 0; i < KIND_RULES.length; i++) {
      const words = KIND_RULES[i][1];
      for (let j = 0; j < words.length; j++) {
        if (s.indexOf(words[j]) >= 0) return KIND_RULES[i][0];
      }
    }
    return '待办';
  }

  /* 从一句话里拆出「时间 / 地点」，剩下的作为事件标题；拆不出来就原样保留 */
  function parseTodoMeta(text) {
    let rest = String(text || '').trim();
    const origin = rest;
    let time = '';

    /* 14:30 / 下午3点 / 上午9点半 / 晚上8点20 */
    const clock = rest.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (clock && clock.index !== undefined) {
      time = pad2(to24(clock[2], clock[1])) + ':' + pad2(clock[3]);
      rest = (rest.slice(0, clock.index) + ' ' + rest.slice(clock.index + clock[0].length)).replace(/\s+/g, ' ').trim();
    } else {
      const point = rest.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点时](半|\d{1,2}分?)?/);
      if (point && point.index !== undefined && !/第$/.test(rest.slice(0, point.index))) {
        const m = point[3] === '半' ? '30' : (point[3] ? pad2(parseInt(point[3], 10)) : '00');
        time = pad2(to24(point[2], point[1])) + ':' + m;
        rest = (rest.slice(0, point.index) + ' ' + rest.slice(point.index + point[0].length)).replace(/\s+/g, ' ').trim();
      }
    }

    /* 地点：命中常见地点后缀，向前最多取 6 个字（遇到标点截断），再去掉「在 / 到 / 于」 */
    let place = '';
    let hitStart = -1;
    let hitEnd = -1;
    for (let i = 0; i < PLACE_WORDS.length; i++) {
      const w = PLACE_WORDS[i];
      const idx = rest.indexOf(w);
      if (idx < 0) continue;
      let start = idx;
      while (start > 0 && idx - start < 6 && !/[，,。；;、！!？?\s]/.test(rest[start - 1])) start--;
      let piece = rest.slice(start, idx + w.length).replace(/^(在|到|去|于|地点[:：]?)/, '');
      if (piece.length > w.length + 6) piece = piece.slice(-(w.length + 6));
      place = piece;
      hitStart = start;
      hitEnd = idx + w.length;
      break;
    }
    if (place) {
      rest = (rest.slice(0, hitStart) + ' ' + rest.slice(hitEnd)).replace(/\s+/g, ' ').trim();
    }

    /* 清理标题两端的标点；拆得太干净就退回原文 */
    let title = rest.replace(/^[\s、，,。；;：:\-—·]+|[\s、，,。；;：:\-—·]+$/g, '');
    /* 开头残留的孤立日期词（「明天 期中质量分析会」）独立成段就去掉 */
    const segs = title.split(/\s+/);
    if (segs.length > 1 && /^(今天|明天|后天|大后天|凌晨|早上|上午|中午|下午|傍晚|晚上)$/.test(segs[0])) {
      title = segs.slice(1).join(' ');
    }
    if (title.length < 2) {
      return { title: origin, time: time, place: '' };
    }
    return { title: title, time: time, place: place };
  }

  /* 卡片右上角的状态药丸 */
  function todoStateHtml(dateISO, todayStr) {
    if (!dateISO) return '';
    if (dateISO < todayStr) return '<span class="todo-state late">逾期 ' + Math.max(1, daysDiff(dateISO, todayStr)) + ' 天</span>';
    if (dateISO === todayStr) return '<span class="todo-state now">今天</span>';
    const diff = daysDiff(todayStr, dateISO);
    if (diff === 1) return '<span class="todo-state soon">明天</span>';
    if (diff <= 3) return '<span class="todo-state">' + diff + ' 天后</span>';
    return '';
  }

  /* 三个标签：时间 / 地点 / 事件 */
  function todoTagsHtml(item, todayStr, dateCls) {
    const dateLabel = item.date ? UI.fmtDate(item.date) : '未定';
    const timePart = item.time ? '<b class="tag-hm">' + esc(item.time) + '</b>' : '';
    const place = item.place
      ? '<span class="todo-tag tt-place" title="地点">' + UI.icon('pin') + '<em>' + esc(item.place) + '</em></span>'
      : '<span class="todo-tag tt-place muted" title="地点">' + UI.icon('pin') + '<em>地点待定</em></span>';
    return '<span class="todo-tag tt-time" title="时间">' + UI.icon('clock') +
      '<em class="' + (dateCls || 'memo-t-date') + '">' + esc(dateLabel) + '</em>' + timePart + '</span>' +
      place +
      '<span class="todo-tag tt-kind" title="事件">' + UI.icon('flag') + '<em>' + esc(item.kind || '待办') + '</em></span>';
  }

  /* 统一排序：日期早→晚；同一天按具体时间早→晚，没有时间的排在后面 */
  function compareTodoItems(a, b) {
    const ad = a.date || '9999-99-99';
    const bd = b.date || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.time !== b.time) {
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time < b.time ? -1 : 1;
    }
    if (a.type !== b.type) return a.type === 'event' ? -1 : 1;
    return 0;
  }

  function fullDayLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + wd;
  }

  /* ---------- 主页周历（周一 → 周日） ---------- */

  function weekCalendarHtml(events, memos, todayStr, selected) {
    const t = new Date(todayStr + 'T00:00:00');
    const monday = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);

    /* 每日事项：周期事件截止 + 未完成备忘录 */
    const byDay = {};
    function put(iso, item) {
      const key = iso && iso.length >= 10 ? iso.slice(0, 10) : '';
      if (!key || key < mondayISO || key > sundayISO) return;
      (byDay[key] = byDay[key] || []).push(item);
    }
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      days.push({ iso: iso, num: d.getDate(), isToday: iso === todayStr });
    }
    const mondayISO = days[0].iso;
    const sundayISO = days[6].iso;

    events.filter(function (e) { return e.status !== 'done'; }).forEach(function (e) {
      put(e.endISO, { kind: 'cycle', label: e.seriesName, time: '', overdue: e.status === 'overdue' });
    });
    (memos || []).forEach(function (m) {
      if (m.done) return;
      put(m.date, { kind: 'memo', label: m.text || '备忘', time: m.time || '', overdue: m.date < todayStr });
    });

    const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
    const cells = days.map(function (d, i) {
      const list = (byDay[d.iso] || []).slice().sort(function (a, b) {
        if (a.time === b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time < b.time ? -1 : 1;
      });
      const items = list.slice(0, 2);
      const more = list.length - items.length;
      const dots = items.map(function (it) {
        return '<span class="cal-item' + (it.overdue ? ' over' : '') + '" title="' + esc(it.label) + '">' +
          '<i></i><em>' + (it.time ? esc(it.time) + ' ' : '') + esc(it.label) + '</em></span>';
      }).join('');
      const cls = 'cal-cell' + (d.isToday ? ' today' : '') + (d.iso === selected ? ' on' : '');
      return '<button class="' + cls + '" data-cal-day="' + d.iso + '" type="button" aria-label="' + d.iso + '">' +
        (list.length ? '<span class="cal-count">' + list.length + '</span>' : '') +
        '<span class="cal-name">' + dayNames[i] + '</span>' +
        '<span class="cal-num">' + d.num + '</span>' +
        '<span class="cal-items">' + dots +
        (more > 0 ? '<span class="cal-more">+' + more + '</span>' : '') +
        (items.length ? '' : '<span class="cal-empty"></span>') + '</span>' +
        '</button>';
    }).join('');

    const weekLabel = parseInt(mondayISO.slice(5, 7), 10) + '月' + parseInt(mondayISO.slice(8), 10) + '日 - ' +
      parseInt(sundayISO.slice(5, 7), 10) + '月' + parseInt(sundayISO.slice(8), 10) + '日';

    return '<div class="cal-card neu">' +
      '<div class="cal-head"><span class="cal-title">本周</span>' +
      '<span class="cal-range">' + weekLabel + '</span></div>' +
      '<div class="cal-grid">' + cells + '</div>' +
      '<p class="cal-tip">点某一天，看当天的待办事项</p>' +
      '</div>';
  }

  /* ---------- 备忘录（快速待办） ---------- */

  async function addMemoFromInput(section) {
    const input = section.querySelector('#memoInput');
    const dateInput = section.querySelector('#memoDate');
    const timeInput = section.querySelector('#memoTime');
    const placeInput = section.querySelector('#memoPlace');
    const text = input ? input.value.trim() : '';
    if (!text) { UI.toast('先写点内容再添加'); if (input) input.focus(); return; }
    const date = dateInput && dateInput.value ? dateInput.value : DB.todayISO();

    /* 一句话里带的「下午3点」「三楼会议室」自动拆成标签；手填的优先 */
    const meta = parseTodoMeta(text);
    const time = (timeInput && timeInput.value) || meta.time || '';
    const place = (placeInput && placeInput.value.trim()) || meta.place || '';

    await DB.addMemo({ text: meta.title, date: date, time: time, place: place });
    UI.toast(time || place ? '已加入待办，时间和地点已整理' : '已加入待办事项', 'ok');
    await render('home');
    const newInput = document.getElementById('memoInput');
    if (newInput) newInput.focus();
  }

  function nextDayISO(iso) {
    if (!iso || iso.length < 10) return DB.todayISO();
    const d = new Date(parseInt(iso.slice(0, 4), 10), parseInt(iso.slice(5, 7), 10) - 1, parseInt(iso.slice(8, 10), 10));
    d.setDate(d.getDate() + 1);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* 备忘录待办卡片：完成 / 推迟 / 修改 / 删除，支持行内编辑 */
  function memoTodoHtml(m, todayStr, idx) {
    const animStyle = ' style="animation-delay:' + Math.min(idx * 60, 360) + 'ms"';

    /* 行内编辑模式 */
    if (state.memoEditId === m.id) {
      return '<div class="memo-todo todo-card neu editing"' + animStyle + '>' +
        '<div class="memo-edit-form">' +
        '<input class="input" id="memoEditInput" type="text" maxlength="60" value="' + esc(m.text) + '" autocomplete="off">' +
        '<div class="memo-edit-row">' +
        '<input class="input memo-date" id="memoEditDate" type="date" value="' + esc(m.date || todayStr) + '" aria-label="日期">' +
        '<input class="input memo-time" id="memoEditTime" type="time" value="' + esc(m.time || '') + '" aria-label="时间">' +
        '</div>' +
        '<input class="input" id="memoEditPlace" type="text" maxlength="24" value="' + esc(m.place || '') +
        '" placeholder="地点，如 三楼会议室" aria-label="地点" autocomplete="off">' +
        '<div class="memo-edit-row">' +
        '<button class="btn primary" data-memo-save="' + m.id + '" type="button">保存</button>' +
        '<button class="btn" data-memo-cancel type="button">取消</button>' +
        '</div>' +
        '</div>' +
        '</div>';
    }

    const overdue = !m.done && m.date && m.date < todayStr;
    const tags = todoTagsHtml({
      date: m.date, time: m.time || '', place: m.place || '', kind: eventKindOf(m.text)
    }, todayStr);

    return '<div class="memo-todo todo-card neu todo-anim' + (m.done ? ' done' : '') + (overdue ? ' overdue' : '') + '"' + animStyle + '>' +
      '<div class="todo-row">' +
      '<button class="memo-check' + (m.done ? ' on' : '') + '" data-memo-toggle="' + m.id + '" type="button" aria-label="完成">' + UI.icon('check') + '</button>' +
      '<div class="todo-body">' +
      '<p class="memo-t-text todo-title">' + esc(m.text) + '</p>' +
      '<div class="todo-tags">' + tags + '</div>' +
      '</div>' +
      (m.done ? '<span class="todo-state ok">已完成</span>' : todoStateHtml(m.date, todayStr)) +
      '</div>' +
      '<div class="todo-foot">' +
      '<span class="memo-actions">' +
      (m.done ? '' : '<button class="memo-act" data-memo-postpone="' + m.id + '" type="button" title="推迟一天">' + UI.icon('chev') + '推迟一天</button>' +
        '<button class="memo-act" data-memo-edit="' + m.id + '" type="button" title="修改内容">' + UI.icon('edit') + '修改</button>') +
      '<button class="memo-act del" data-memo-del="' + m.id + '" type="button" aria-label="删除">' + UI.icon('close') + '</button>' +
      '</span>' +
      '</div>' +
      '</div>';
  }

  /* 快速添加行（放在待办列表上方）：一句话 + 日期 / 时间 / 地点 */
  function memoQuickAddHtml(todayStr, dayFilter) {
    const dateVal = dayFilter || todayStr;
    return '<div class="memo-add neu">' +
      '<div class="memo-add-line">' +
      '<input class="input" id="memoInput" type="text" maxlength="60" placeholder="记一条待办，回车快速加入" autocomplete="off">' +
      '<button class="btn primary memo-add-btn" data-memo-add type="button" aria-label="添加">' + UI.icon('plus') + '</button>' +
      '</div>' +
      '<div class="memo-add-meta">' +
      '<label class="mini-field"><span>日期</span><input class="input memo-date" id="memoDate" type="date" value="' + dateVal + '"></label>' +
      '<label class="mini-field"><span>时间</span><input class="input memo-time" id="memoTime" type="time"></label>' +
      '<label class="mini-field grow"><span>地点</span><input class="input" id="memoPlace" type="text" maxlength="24" placeholder="如 三楼会议室" autocomplete="off"></label>' +
      '</div>' +
      '<p class="memo-add-hint">只写一句话也行：带「下午3点」「三楼会议室」会自动整理成标签</p>' +
      '</div>';
  }

  async function homeHtml(todayStr) {
    const totalBytes = state.docs.reduce(function (s, d) { return s + (d.size || 0); }, 0);
    const memos = await DB.listMemos();

    /* 待做事项：周期事件 + 备忘录，统一按「事件时间」排序 */
    const events = Events.compute(state.docs, state.series, todayStr);
    const pendingAll = events.filter(function (e) { return e.status !== 'done'; });
    const hasPeriodic = periodicSeries().length > 0;
    const alertCount = events.filter(function (e) { return e.status === 'overdue' || e.remind; }).length;
    const openMemosList = memos.filter(function (m) { return !m.done; });
    const openMemos = openMemosList.length;
    const doneMemos = memos.filter(function (m) { return m.done; });
    const doneEvents = events.filter(function (e) { return e.status === 'done'; });
    const doneCount = doneMemos.length + doneEvents.length;

    const dayFilter = state.home.day || '';

    const evItems = pendingAll.map(function (e) {
      return { type: 'event', date: e.endISO || '', time: '', ev: e };
    });
    const memoItems = openMemosList.map(function (m) {
      return { type: 'memo', date: m.date || '', time: m.time || '', memo: m };
    });
    const todoItems = evItems.concat(memoItems).sort(compareTodoItems);

    const shownItems = dayFilter
      ? todoItems.filter(function (it) { return it.date === dayFilter; })
      : todoItems.slice(0, 10);
    const hiddenCount = dayFilter ? 0 : todoItems.length - shownItems.length;

    /* 按合并后的顺序重新编号，让入场动画错开 */
    shownItems.forEach(function (it, i) {
      it.html = it.type === 'memo' ? memoTodoHtml(it.memo, todayStr, i) : evCardHtml(it.ev, todayStr, i);
    });

    const filterHtml = dayFilter
      ? '<div class="day-filter">' +
        '<span class="df-label">' + UI.icon('calendar') + '只看 <b>' + esc(fullDayLabel(dayFilter)) + '</b> · ' + shownItems.length + ' 个</span>' +
        '<button class="df-clear" data-cal-clear type="button">查看全部</button>' +
        '</div>'
      : '';

    let todoHtml;
    if (!shownItems.length) {
      todoHtml = dayFilter
        ? emptyBlock('这一天没有待办', '上面的快速添加已经把日期选到这一天，补一条就行')
        : emptyBlock('没有待办事项', hasPeriodic ? '所有周期都已归档文档，继续保持' : '记一条备忘，或在设置里给系列开启周期事件') +
          (hasPeriodic ? '' : '<div style="text-align:center;margin-top:-20px"><button class="btn primary" data-ev-new-series type="button">' + UI.icon('plus') + '新建系列模板</button></div>');
    } else {
      todoHtml = '<div class="doc-list">' + shownItems.map(function (it) { return it.html; }).join('') + '</div>' +
        (hiddenCount > 0
          ? '<div class="todo-more"><button class="btn" data-nav="events" type="button">还有 ' + hiddenCount + ' 个待办，全部查看</button></div>'
          : '');
    }

    /* 周历：周一 → 周日 + 每日待办；点日期筛选当天待办 */
    const calHtml = weekCalendarHtml(events, memos, todayStr, dayFilter);

    /* 关键词自动关联：从文档正文提取；用户自选的词优先展示 */
    const kw = Keywords.build(state.docs, { title: '内容关键词关联', pinned: state.kwPinned || [] });

    /* 近一周项目：归档日期在最近 7 天内，按系列分组 */
    const start = new Date();
    start.setDate(start.getDate() - 6);
    const weekStartISO = DB.toISO(start);
    const weekDocs = state.docs.filter(function (d) {
      return d.archiveDate && d.archiveDate >= weekStartISO && d.archiveDate <= todayStr;
    });
    const groups = {};
    weekDocs.forEach(function (d) {
      const k = d.seriesId || 0;
      (groups[k] = groups[k] || []).push(d);
    });
    const groupKeys = Object.keys(groups).sort(function (a, b) {
      const la = groups[a].reduce(function (m, d) { return d.archiveDate > m ? d.archiveDate : m; }, '');
      const lb = groups[b].reduce(function (m, d) { return d.archiveDate > m ? d.archiveDate : m; }, '');
      return la < lb ? 1 : -1;
    });

    const weekHtml = groupKeys.length
      ? '<div class="rows">' + groupKeys.map(function (k) {
          const list = groups[k];
          const latest = list.reduce(function (m, d) { return d.archiveDate > m.archiveDate ? d : m; }, list[0]);
          if (k === '0' || k === 0) {
            return '<button class="row-item neu press" data-nav="archive" type="button">' +
              '<span class="r-name">未分类</span>' +
              '<span class="r-series"><span class="badge muted">' + list.length + ' 份</span></span>' +
              '<span class="r-dates"><span>最新 ' + esc(latest.name) + '</span><span>' + esc(UI.fmtDate(latest.archiveDate)) + '</span></span>' +
              '</button>';
          }
          return '<button class="row-item neu press" data-nav-stats="' + k + '" type="button">' +
            '<span class="r-name">' + esc(seriesName(parseInt(k, 10)) || '系列') + '</span>' +
            '<span class="r-series"><span class="badge">' + list.length + ' 份</span></span>' +
            '<span class="r-dates"><span>最新 ' + esc(latest.name) + '</span><span>' + esc(UI.fmtDate(latest.archiveDate)) + '</span></span>' +
            '</button>';
        }).join('') + '</div>'
      : emptyBlock('近一周没有新归档', '点右下角加号添加文件，这里会按系列分组展示');

    /* 最近添加的文件：按入库时间新→旧 */
    const recent = state.docs.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 6);
    const recentHtml = recent.length
      ? '<div class="doc-list">' + recent.map(function (d) {
          const kind = Parser.kindOf(d.name);
          const sn = seriesName(d.seriesId);
          return '<button class="doc-card neu press" data-open="' + d.id + '" type="button">' +
            '<span class="icon-box ' + kind + '">' + UI.icon(UI.kindIcon(kind)) + '</span>' +
            '<span class="meter">' +
            '<span class="doc-name">' + esc(d.name) + '</span>' +
            '<span class="doc-meta"><span>' + esc(UI.fmtDate(d.archiveDate)) + '</span>' +
            (sn ? '<span class="dot"></span><span>' + esc(sn) + '</span>' : '') + '</span>' +
            '</span>' +
            '<span class="doc-side">' + (sn ? '<span class="badge">' + esc(sn) + '</span>' : typeBadge(kind)) + seqBadgeHtml(d) + ocrBadgeHtml(d) + '</span>' +
            '</button>';
        }).join('') + '</div>'
      : emptyBlock('还没有文件', '点右下角的加号，选取文件或拍照归档');

    const head = state.docs.length
      ? '<div class="topbar slim"><div>' +
        '<p class="meta">' + esc(weekDateLabel()) + ' · 共 ' + state.docs.length + ' 份 · 已用 ' + UI.fmtSize(totalBytes) + '</p>' +
        '</div></div>'
      : '';

    return head +
      (state.docs.length ? '' : '<div class="topbar"><div>' +
        '<p class="meta">' + esc(weekDateLabel()) + '</p>' +
        '<h1 class="hand">欢迎使用工作文件</h1>' +
        '<p class="sub">数据保存在这台设备的浏览器里，不上传、不联网</p>' +
        '</div></div>') +
      '<div class="section-title todo-anchor" id="todoAnchor"><span>待做事项</span><span class="title-side">' +
      '<span class="count">' + (dayFilter ? shownItems.length + ' / ' + todoItems.length : (hasPeriodic ? pendingAll.length : 0) + openMemos) + ' 个</span>' +
      '<button class="section-link" data-todo-done type="button" title="查看待办与周期事件的完成记录">完成记录' + UI.icon('chev') + '</button>' +
      '</span></div>' +
      filterHtml +
      memoQuickAddHtml(todayStr, dayFilter) +
      todoHtml +
      (kw.html ? kw.html : '') +
      '<div class="section-title"><span>本周日程</span><span class="count">点日期看当天</span></div>' +
      calHtml +
      '<div class="section-title"><span>近一周项目</span><span class="count">' + weekDocs.length + ' 份</span></div>' +
      weekHtml +
      '<div class="section-title"><span>最近添加的文件</span>' + sectionLink('archive') + '</div>' +
      recentHtml +
      (state.docs.length ? '' : '<div class="import-cta"><button class="btn primary block" data-import-open type="button">' +
        UI.icon('upload') + '从手机导入文件或备份</button>' +
        '<p class="inline-hint" style="text-align:center;margin-top:8px">换手机？电脑端导出备份 zip 后传到手机，点这里导入即可</p></div>');
  }

  /* 待做事项完成记录：已完成备忘 + 已完成周期事件，全部来自本地真实记录 */
  async function openTodoDone() {
    const memos = await DB.listMemos();
    const doneMemos = memos.filter(function (m) { return m.done; })
      .sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '') || ((b.updatedAt || 0) - (a.updatedAt || 0));
      });
    const doneEvents = Events.compute(state.docs, state.series, DB.todayISO())
      .filter(function (e) { return e.status === 'done'; })
      .sort(function (a, b) { return a.endISO < b.endISO ? 1 : -1; });

    const memoHtml = doneMemos.length
      ? doneMemos.map(function (m) {
          const meta = [UI.fmtDate(m.date), m.time, m.place].filter(Boolean).join(' · ');
          return '<div class="row-item neu">' +
            '<span class="r-name">' + esc(m.text || '备忘') + '</span>' +
            '<span class="r-series"><span class="badge muted">待办</span></span>' +
            '<span class="r-dates"><span>' + esc(meta) + '</span><span>已完成</span></span>' +
            '</div>';
        }).join('')
      : emptyBlock('还没有完成的待办', '勾选待办左侧的完成按钮后，记录会出现在这里');

    const eventHtml = doneEvents.length
      ? doneEvents.map(function (ev) {
          const extra = ev.docs.length > 1 ? ' 等 ' + ev.docs.length + ' 份' : '';
          return '<button class="row-item neu press" data-done-open="' + ev.topDoc.id + '" type="button">' +
            '<span class="r-name">' + esc(ev.seriesName) + '</span>' +
            '<span class="r-series"><span class="badge">' + esc(ev.label) + '</span></span>' +
            '<span class="r-dates"><span>' + esc(ev.topDoc.name) + extra + '</span><span>已完成 · ' + esc(UI.fmtDate(ev.endISO)) + '</span></span>' +
            '</button>';
        }).join('')
      : emptyBlock('还没有完成的周期', '归档对应周期的文档后，完成记录会出现在这里');

    const html = '<div class="done-records">' +
      '<div class="section-title"><span>已完成待办</span><span class="count">' + doneMemos.length + ' 条</span></div>' +
      '<div class="rows">' + memoHtml + '</div>' +
      '<div class="section-title"><span>已完成周期</span><span class="count">' + doneEvents.length + ' 个</span></div>' +
      '<div class="rows">' + eventHtml + '</div>' +
      '</div>';

    UI.openDrawer('完成记录', html, function (body) {
      body.addEventListener('click', async function (e) {
        const b = e.target.closest('[data-done-open]');
        if (!b) return;
        const doc = await DB.getDocument(parseInt(b.getAttribute('data-done-open'), 10));
        if (!doc) { UI.toast('原文件已删除，无法查看'); return; }
        UI.closeDrawer();
        Viewer.open(doc);
      });
    });
  }

  /* ---------- 归档 ---------- */

  function archiveHtml() {
    const sortKey = state.archive.sort === 'fileDate' ? 'fileDate' : 'archiveDate';
    const sortDate = function (d) {
      return sortKey === 'fileDate' ? (d.fileDate || d.archiveDate || '') : (d.archiveDate || '');
    };
    const monthKey = function (d) { return sortDate(d).slice(0, 7); };

    const months = monthsOf(state.docs, sortKey);
    const month = state.archive.month;
    const fkey = state.archive.folder || 'all';
    const unclassified = state.docs.filter(function (d) { return !d.folderId; }).length;

    let docs = state.docs.slice();
    if (fkey === 'none') docs = docs.filter(function (d) { return !d.folderId; });
    else if (fkey !== 'all') docs = docs.filter(function (d) { return String(d.folderId) === String(parseInt(fkey, 10)); });
    if (month !== 'all') docs = docs.filter(function (d) { return monthKey(d) === month; });

    docs.sort(function (a, b) { return DB.compareDocs(a, b, sortKey); });

    const totalBytes = state.docs.reduce(function (s, d) { return s + (d.size || 0); }, 0);
    const shown = docs.slice(0, state.archive.visible);

    let listHtml = '';
    let lastMonth = '';
    shown.forEach(function (d) {
      const m = monthKey(d);
      if (m !== lastMonth) {
        const groupCount = docs.filter(function (x) { return monthKey(x) === m; }).length;
        listHtml += '<div class="section-title"><span>' + esc(UI.monthLabel(m)) + '</span><span class="count">' + groupCount + ' 份</span></div>';
        lastMonth = m;
      }
      const kind = Parser.kindOf(d.name);
      const sn = seriesName(d.seriesId);
      const fn = d.folderId ? folderPath(d.folderId) : '';
      const picked = state.archive.multi && state.archive.picked.indexOf(d.id) >= 0;
      listHtml += '<button class="doc-card neu press' + (picked ? ' picked' : '') + '" data-open="' + d.id + '" type="button">' +
        (state.archive.multi
          ? '<span class="pick-box' + (picked ? ' on' : '') + '">' + UI.icon('check') + '</span>'
          : '') +
        '<span class="icon-box ' + kind + '">' + UI.icon(UI.kindIcon(kind)) + '</span>' +
        '<span class="meter">' +
        '<span class="doc-name">' + esc(d.name) + '</span>' +
        '<span class="doc-meta">' +
        '<span>文件 ' + esc(UI.fmtDate(d.fileDate)) + '</span>' +
        '<span class="dot"></span>' +
        '<span>归档 ' + esc(UI.fmtDate(d.archiveDate)) + '</span>' +
        (fn ? '<span class="dot"></span><span class="doc-folder">' + UI.icon('folder') + esc(fn) + '</span>' : '') +
        (d.extractStatus === 'failed' || d.extractStatus === 'skipped' ? '<span class="dot"></span><span>未提取</span>' : '') +
        '</span>' +
        '</span>' +
        '<span class="doc-side">' + (sn ? '<span class="badge">' + esc(sn) + '</span>' : typeBadge(kind)) + seqBadgeHtml(d) + ocrBadgeHtml(d) + '</span>' +
        '</button>';
    });

    if (docs.length > shown.length) {
      listHtml += '<div style="padding:16px 0 4px;text-align:center"><button class="btn" data-more-archive type="button">加载更多（余 ' + (docs.length - shown.length) + ' 份）</button></div>';
    }

    const monthChips = ['all'].concat(months.slice(0, 8)).map(function (m) {
      return '<button class="chip' + (m === month ? ' on' : '') + '" data-month="' + m + '" type="button">' + esc(m === 'all' ? '全部' : UI.monthLabel(m)) + '</button>';
    }).join('');

    /* 文件夹栏：全部 / 未归类 / 主文件夹（仅顶层，子文件夹进文件夹里看） / 自动归档 / ＋新建 */
    const folderChips = (function () {
      if (!state.docs.length && !state.folders.length) return '';
      const docCount = function (fid) {
      return folderDeepCount(fid);
    };
    const items =
        '<button class="fchip' + (fkey === 'all' ? ' on' : '') + '" data-folder="all" type="button">' +
        UI.icon('archive') + '全部<b>' + state.docs.length + '</b></button>' +
        '<button class="fchip' + (fkey === 'none' ? ' on' : '') + '" data-folder="none" type="button">' +
        UI.icon('inbox') + '未归类<b>' + unclassified + '</b></button>' +
        folderKids(null).map(function (f) {
          return '<button class="fchip' + (String(fkey) === String(f.id) ? ' on' : '') + '" data-folder="' + f.id + '" type="button">' +
            UI.icon('folder') + esc(f.name) + '<b>' + docCount(f.id) + '</b></button>';
        }).join('') +
        (unclassified ? '<button class="fchip auto" data-auto-archive type="button" title="按文件名自动归入名称关联的文件夹">' +
          UI.icon('spark') + '自动归档</button>' : '') +
        '<button class="fchip new" data-folder-new type="button">' + UI.icon('plus') + '新建文件夹</button>';
      return '<div class="folder-bar"><div class="folder-scroll">' + items + '</div></div>';
    })();

    const curFolder = fkey !== 'all' && fkey !== 'none' ? folderById(parseInt(fkey, 10)) : null;
    /* 面包屑路径：每一段都是可点击的蓝色链接，直接跳到对应文件夹 */
    const folderCrumb = curFolder
      ? folderChainIds(curFolder.id).map(function (fid, i, arr) {
          return '<button class="ft-crumb' + (i === arr.length - 1 ? ' cur' : '') + '" data-folder="' + fid + '" type="button">' +
            esc(folderById(fid).name) + '</button>';
        }).join('<span class="ft-sep">/</span>')
      : '';
    const folderTools = curFolder
      ? '<div class="folder-tools"><span class="ft-name">' + UI.icon('folder') +
        '<span class="ft-crumb-wrap">' + folderCrumb + '</span>' +
        '<b>' + folderDeepCount(curFolder.id) + ' 份</b></span>' +
        '<span class="ft-acts">' +
        (curFolder.parentId
          ? '<button class="ft-btn" data-folder-back="' + curFolder.parentId + '" type="button">‹ 返回上一级</button>'
          : '<button class="ft-btn" data-folder-back="all" type="button">‹ 返回全部</button>') +
        '<button class="ft-btn" data-folder-sub="' + curFolder.id + '" type="button">新建子文件夹</button>' +
        '<button class="ft-btn" data-folder-move="' + curFolder.id + '" type="button">移动</button>' +
        '<button class="ft-btn" data-folder-rename="' + curFolder.id + '" type="button">重命名</button>' +
        '<button class="ft-btn danger" data-folder-del="' + curFolder.id + '" type="button">删除</button>' +
        '</span></div>'
      : '';

    /* 子文件夹色块：显示在上级文件夹内部（Windows 式），用比主文件夹更浅的色块 */
    const subFoldersHtml = curFolder ? (function () {
      const kids = folderKids(curFolder.id);
      if (!kids.length) return '';
      return '<div class="section-title"><span>子文件夹</span><span class="count">' + kids.length + ' 个</span></div>' +
        '<div class="subfolder-grid">' +
        kids.map(function (f) {
          const deep = folderKids(f.id).length;
          const n = folderDeepCount(f.id);
          return '<button class="fsub' + (String(fkey) === String(f.id) ? ' on' : '') + '" data-folder="' + f.id + '" type="button">' +
            '<span class="fsub-ico">' + UI.icon('folder') + '</span>' +
            '<span class="fsub-name">' + esc(f.name) + '</span>' +
            '<span class="fsub-meta"><b>' + n + '</b> 份' + (deep ? ' · 含子文件夹' : '') + '</span>' +
            (deep ? '<span class="fsub-chev">' + UI.icon('chev') + '</span>' : '') +
            '</button>';
        }).join('') +
        '</div>';
    })() : '';

    return '<div class="topbar">' +
      '<div>' +
      '<p class="meta">共 ' + state.docs.length + ' 份 · 已用 ' + UI.fmtSize(totalBytes) + '</p>' +
      '<p class="sub">' + (state.archive.multi
        ? '多选模式：点文件勾选，一次归入同一个文件夹'
        : (state.archive.sort === 'fileDate' ? '按文件名日期新→旧' : '按归档时间新→旧')) + '</p>' +
      '</div>' +
      '<div class="topbar-actions">' +
      '<button class="icon-btn neu press toggle' + (state.archive.multi ? ' on' : '') + '" data-multi type="button" aria-label="多选文件" title="多选文件">' +
      UI.icon('menu') + '</button>' +
      '<button class="icon-btn neu press" data-import-open type="button" aria-label="导入文件" title="导入文件">' + UI.icon('upload') + '</button>' +
      '<button class="icon-btn neu press toggle' + (state.archive.sort === 'fileDate' ? ' on' : '') + '" data-sort type="button" aria-label="切换排序">' + UI.icon('sort') + '</button>' +
      '</div>' +
      '</div>' +
      folderChips +
      folderTools +
      subFoldersHtml +
      (state.docs.length ? '<div class="chip-scroll"><div class="chips" data-chips><span class="chip-bg"></span>' + monthChips + '</div></div>' : '') +
      '<div class="doc-list' + (state.archive.multi ? ' picking' : '') + '" style="margin-top:14px">' +
      (docs.length ? listHtml : emptyBlock(
        state.docs.length ? '这个文件夹还是空的' : '这里还没有文件',
        state.docs.length ? '归档时在「归档到文件夹」里选它，或点文件详情改归属' : '点右下角的加号，选取文件或拍照归档')) + '</div>' +
      (state.archive.multi
        ? '<div class="multi-bar neu"><span class="mb-count">已选 ' + state.archive.picked.length + ' 份</span>' +
          '<span class="mb-acts">' +
          '<button class="ft-btn" data-pick-all type="button">' + (state.archive.picked.length === docs.length && docs.length ? '全不选' : '全选') + '</button>' +
          '<button class="ft-btn primary" data-multi-move type="button"' + (state.archive.picked.length ? '' : ' disabled') + '>移动到文件夹</button>' +
          '<button class="ft-btn" data-multi-exit type="button">退出多选</button>' +
          '</span></div>'
        : '');
  }

  /* ---------- 记录 ---------- */

  function recordsHtml() {
    let docs = state.docs.slice();
    if (state.records.filter === 'abnormal') docs = docs.filter(isAbnormal);
    docs.sort(function (a, b) { return DB.compareDocs(a, b, 'archiveDate'); });
    const shown = docs.slice(0, state.records.visible);

    let rows = shown.map(function (d) {
      const abnormal = isAbnormal(d);
      const late = d.fileDate && d.archiveDate && d.fileDate > d.archiveDate;
      return '<button class="row-item neu press" data-edit="' + d.id + '" type="button">' +
        '<span class="r-name">' + esc(d.name) + '</span>' +
        '<span class="r-series">' + (seriesName(d.seriesId) ? '<span class="badge">' + esc(seriesName(d.seriesId)) + '</span>' : '') + '</span>' +
        '<span class="r-dates">' +
        '<span>归档 <b>' + esc(d.archiveDate || '—') + '</b></span>' +
        '<span>文件 <b>' + esc(d.fileDate || '未识别') + '</b></span>' +
        (late ? '<span class="tag-warn">文件日期晚于归档</span>' : '') +
        (!d.fileDate ? '<span class="tag-warn">待补录</span>' : '') +
        '</span>' +
        '</button>';
    }).join('');

    if (docs.length > shown.length) {
      rows += '<div style="padding:8px 0;text-align:center"><button class="btn" data-more-records type="button">加载更多（余 ' + (docs.length - shown.length) + ' 份）</button></div>';
    }

    const abnormalCount = state.docs.filter(isAbnormal).length;

    return '<div class="topbar"><div>' +
      '<p class="meta">归档日期与文件名日期对照</p>' +
      '<p class="sub">' + (abnormalCount ? abnormalCount + ' 份待核对' : '日期均可追溯') + '</p>' +
      '</div></div>' +
      '<div class="chip-scroll"><div class="chips" data-chips><span class="chip-bg"></span>' +
      '<button class="chip' + (state.records.filter === 'all' ? ' on' : '') + '" data-record-filter="all" type="button">全部</button>' +
      '<button class="chip' + (state.records.filter === 'abnormal' ? ' on' : '') + '" data-record-filter="abnormal" type="button">待核对 ' + abnormalCount + '</button>' +
      '</div></div>' +
      '<div class="rows" style="margin-top:14px">' + (docs.length ? rows : emptyBlock(
        state.records.filter === 'abnormal' ? '没有待核对的记录' : '这里还没有文件',
        state.records.filter === 'abnormal' ? '所有文件的归档日期与文件名日期都正常' : '归档文件后，双日期会在这里对照显示'
      )) + '</div>';
  }

  /* ---------- 统计 ---------- */

  function statsHtml() {
    if (!state.series.length) {
      return '<div class="topbar"><div>' +
        '<p class="meta">按文档系列生成对照表</p>' +
        '<p class="sub">先建一个系列模板</p>' +
        '</div></div>' +
        emptyBlock('还没有系列模板', '系列模板定义一组字段，同系列的文档会自动排成一张表') +
        '<div style="text-align:center;margin-top:-20px"><button class="btn primary" data-new-series type="button">' + UI.icon('plus') + '新建系列模板</button></div>';
    }

    if (!state.stats.seriesId) {
      const counts = {};
      state.docs.forEach(function (d) {
        if (d.seriesId) counts[d.seriesId] = (counts[d.seriesId] || 0) + 1;
      });
      const cards = state.series.map(function (s) {
        const n = counts[s.id] || 0;
        const cycleBadge = s.cycle === 'week' || s.cycle === 'month'
          ? '<span class="badge">' + (s.cycle === 'week' ? '每周' : '每月') + (s.included === false ? ' · 停用' : '') + '</span>' : '';
        const fieldChips = (s.fields || []).slice(0, 4).map(function (f) {
          return '<span class="badge muted">' + esc(f.label) + '</span>';
        }).join('');
        return '<button class="series-card neu press" data-series-open="' + s.id + '" type="button">' +
          '<span class="icon-box">' + UI.icon('template') + '</span>' +
          '<span class="meter">' +
          '<span class="s-name">' + esc(s.name) + '</span>' +
          '<span class="s-meta">' + n + ' 份 · ' + (s.fields || []).length + ' 个字段</span>' +
          '<span class="s-fields">' + fieldChips + cycleBadge + '</span>' +
          '</span>' +
          '<span class="chev">' + UI.icon('chev') + '</span>' +
          '</button>';
      }).join('');

      return '<div class="topbar"><div>' +
        '<p class="meta">按文档系列生成对照表</p>' +
        '<p class="sub">' + state.series.length + ' 个系列</p>' +
        '</div><button class="icon-btn neu press" data-new-series type="button" aria-label="新建模板">' + UI.icon('plus') + '</button></div>' +
        '<div class="doc-list" style="margin-top:6px">' + cards + '</div>';
    }

    const s = seriesById(state.stats.seriesId);
    if (!s) { state.stats.seriesId = null; return statsHtml(); }

    const docs = state.docs.filter(function (d) { return d.seriesId === s.id; })
      .sort(function (a, b) { return DB.compareDocs(a, b, 'fileDate'); });

    const fields = s.fields || [];
    const head = '<tr><th>文件名</th><th>文件日期</th>' + fields.map(function (f) { return '<th>' + esc(f.label) + '</th>'; }).join('') + '</tr>';
    const body = docs.map(function (d) {
      const cells = fields.map(function (f) {
        const v = d.fields && d.fields[f.key] != null ? d.fields[f.key] : '';
        return '<td class="' + (f.type === 'number' ? 'num' : '') + '">' + esc(v || '—') + '</td>';
      }).join('');
      return '<tr data-open="' + d.id + '"><td class="name cell-strong">' + esc(d.name) + '</td><td class="num">' + esc(d.fileDate || '—') + '</td>' + cells + '</tr>';
    }).join('');

    return '<div class="topbar"><div>' +
      '<button class="btn ghost" data-series-back type="button" style="height:auto;padding:0;margin-bottom:6px">' + UI.icon('chev') + '全部系列</button>' +
      '<p class="sub">「' + esc(s.name) + '」 · ' + docs.length + ' 份 · ' + fields.length + ' 个字段 · 按文件日期新→旧</p>' +
      '</div><button class="icon-btn neu press" data-export-csv type="button" aria-label="导出 CSV">' + UI.icon('download') + '</button></div>' +
      (docs.length
        ? '<div class="inline-hint" style="margin:0 2px 8px">表格可左右滑动查看全部列</div>' +
          '<div class="table-wrap"><table class="grid"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
        : emptyBlock('这个系列还没有文档', '添加文件时选择「' + s.name + '」，表格会自动生成'));
  }

  /* ---------- 查询 ---------- */

  let searchResults = [];

  /* 结果摘录：转义后高亮关键词 */
  function markSnippet(snippet, q) {
    const safe = esc(snippet || '');
    if (!q) return safe;
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return safe.replace(re, '<mark class="kw-hit">$1</mark>');
  }

  /* v2.7.0 自定义筛选词：匹配结果区上方的词签，点词即按该词重新检索 */
  function filterBarHtml() {
    const q = state.search.q.trim();
    return '<div class="qf-bar">' +
      (state.search.filterWords || []).map(function (w) {
        return '<button class="chip qf-word' + (q === w ? ' on' : '') + '" data-q-filter-word="' + esc(w) + '" type="button" title="按此词筛选">' + esc(w) + '</button>';
      }).join('') +
      '<button class="btn sm ghost qf-manage" data-q-filter-manage type="button" title="管理自定义筛选词">＋ 筛选词</button>' +
      '</div>';
  }

  function searchResultsHtml() {
    const q = state.search.q.trim();
    const title = '<div class="section-title"><span>匹配结果</span><span class="count">' +
      (q && searchResults.length ? searchResults.length + ' 条 · 点击直达文件' : '自定义筛选词') + '</span></div>';
    if (!q) {
      return title + filterBarHtml() +
        emptyBlock('输入关键词开始查找', '在顶部搜索栏输入即可，文件名、字段值、文档正文、图片中的文字都会参与匹配');
    }
    if (!searchResults.length) {
      return title + filterBarHtml() +
        emptyBlock('没有找到匹配的文件', '换个关键词，或放宽系列与类型筛选');
    }
    const rows = searchResults.map(function (r) {
      const d = r.doc;
      const sn = seriesName(d.seriesId);
      const hitLabel = r.hit === 'text' ? '<span class="badge">全文</span>'
        : (r.hit === 'ocr' ? '<span class="badge ocr">图片文字</span>'
          : (r.hit === 'fields' ? '<span class="badge muted">字段</span>' : ''));
      return '<tr class="search-row" data-view-open="' + d.id + '" title="点击直接打开文件并定位到关键词">' +
        '<td class="name cell-strong">' + esc(d.name) + hitLabel + '</td>' +
        '<td class="num">' + esc(d.fileDate || '—') + '</td>' +
        '<td>' + esc(sn || '—') + '</td>' +
        '<td class="name" style="max-width:260px">' + markSnippet(r.snippet || (r.hit === 'name' ? '文件名命中' : '—'), q) + '</td>' +
        '</tr>';
    }).join('');
    return title + filterBarHtml() +
      '<div class="inline-hint" style="margin:0 2px 8px">点任意一行，直接打开文件并定位到关键词位置</div>' +
      '<div class="table-wrap"><table class="grid"><thead><tr><th>文件名</th><th>文件日期</th><th>系列</th><th>命中内容</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function searchHtml() {
    const q = state.search.q.trim();
    const seriesChips = '<button class="chip' + (!state.search.seriesId ? ' on' : '') + '" data-q-series="" type="button">全部系列</button>' +
      state.series.map(function (s) {
        return '<button class="chip' + (state.search.seriesId === s.id ? ' on' : '') + '" data-q-series="' + s.id + '" type="button">' + esc(s.name) + '</button>';
      }).join('');

    const typeChips = [['', '全部类型'], ['doc', '文档'], ['sheet', '表格'], ['pdf', 'PDF'], ['image', '图片']].map(function (t) {
      return '<button class="chip' + ((state.search.ext || '') === t[0] ? ' on' : '') + '" data-q-type="' + t[0] + '" type="button">' + t[1] + '</button>';
    }).join('');

    return '<div class="topbar"><div>' +
      '<p class="meta">' + (q ? '正在检索「' + esc(q) + '」· 关键词检索文件名、字段、正文与图片文字' : '在顶部搜索栏输入关键词') + '</p>' +
      '</div></div>' +
      '<div class="chip-scroll" style="margin-top:12px"><div class="chips" data-chips><span class="chip-bg"></span>' + seriesChips + '</div></div>' +
      '<div class="chip-scroll" style="margin-top:8px"><div class="chips" data-chips><span class="chip-bg"></span>' + typeChips + '</div></div>' +
      '<div id="searchResults" style="margin-top:6px">' + searchResultsHtml() + '</div>';
  }

  /* 外部（全局搜索栏 / 关键词关联表）设置关键词 */
  async function setSearchQuery(q) {
    state.search.q = q || '';
    if (state.tab !== 'search') {
      await window.App.switchTab('search', true);
    } else {
      await render('search');
    }
  }

  async function runSearch() {
    const q = state.search.q.trim();
    if (!q) { searchResults = []; return; }
    searchResults = await DB.searchDocuments({
      q: q,
      seriesId: state.search.seriesId || null,
      ext: state.search.ext || null
    });
  }

  /* v2.7.0 自定义筛选词：增「＋」/ 改「✎」/ 删「×」，只写 settings，不新增 IndexedDB 表 */
  function openSearchFilterWords() {
    let words = (state.search.filterWords || []).slice();
    let editing = '';

    function listHtml() {
      if (!words.length) return '<p class="kw-tip muted">还没有筛选词，在下方输入一个即可。</p>';
      return '<div class="qf-list">' + words.map(function (w) {
        return '<div class="qf-row"><span class="qf-tag">' + esc(w) + '</span>' +
          '<button class="qf-sym" data-qf-edit="' + esc(w) + '" type="button" title="修改">✎</button>' +
          '<button class="qf-sym danger" data-qf-del="' + esc(w) + '" type="button" title="删除">×</button></div>';
      }).join('') + '</div>';
    }

    const html = '<div class="form">' +
      '<div class="field"><label>自定义筛选词<span class="hint">点词即用它重新检索，最多 12 个</span></label>' +
      '<div id="qfList">' + listHtml() + '</div></div>' +
      '<div class="field"><label for="qfNew" id="qfLabel">添加筛选词</label>' +
      '<div class="kw-add-row">' +
      '<input class="input" id="qfNew" maxlength="12" placeholder="输入关键词" autocomplete="off">' +
      '<button class="btn primary" data-qf-add type="button">＋</button>' +
      '</div></div>' +
      '<div class="form-actions">' +
      '<button class="btn" data-qf-cancel type="button">取消</button>' +
      '<button class="btn primary" data-qf-save type="button">保存</button></div></div>';

    UI.openDrawer('自定义筛选词', html, function (body) {
      const input = body.querySelector('#qfNew');
      const addBtn = body.querySelector('[data-qf-add]');
      const list = body.querySelector('#qfList');
      const label = body.querySelector('#qfLabel');

      function repaint() {
        if (list) list.innerHTML = listHtml();
        if (addBtn) addBtn.textContent = editing ? '改' : '＋';
        if (label) label.textContent = editing ? '修改「' + editing + '」' : '添加筛选词';
      }
      function commit() {
        const w = String(input ? input.value : '').trim().slice(0, 12);
        if (!w) return;
        if (editing) {
          const i = words.indexOf(editing);
          if (i >= 0) words[i] = w;
          editing = '';
        } else {
          if (words.indexOf(w) >= 0) { UI.toast('这个词已经有了'); return; }
          if (words.length >= 12) { UI.toast('最多 12 个筛选词'); return; }
          words.push(w);
        }
        if (input) { input.value = ''; input.focus(); }
        repaint();
      }

      body.addEventListener('click', async function (e) {
        const edit = e.target.closest('[data-qf-edit]');
        if (edit) {
          editing = edit.getAttribute('data-qf-edit');
          if (input) { input.value = editing; input.focus(); }
          repaint();
          return;
        }
        const del = e.target.closest('[data-qf-del]');
        if (del) {
          const w = del.getAttribute('data-qf-del');
          words = words.filter(function (x) { return x !== w; });
          if (editing === w) { editing = ''; if (input) input.value = ''; }
          repaint();
          return;
        }
        if (e.target.closest('[data-qf-add]')) { commit(); return; }
        if (e.target.closest('[data-qf-cancel]')) { UI.closeDrawer(); return; }
        if (e.target.closest('[data-qf-save]')) {
          commit();
          await DB.setSetting('searchFilterWords', words);
          state.search.filterWords = words.slice();
          UI.closeDrawer();
          await render('search');
          UI.toast(words.length ? '已保存 ' + words.length + ' 个筛选词' : '已清空筛选词', 'ok');
          return;
        }
      });
      body.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && input && e.target === input) { e.preventDefault(); commit(); }
      });
    });
  }

  /* ---------- 事件 ---------- */

  function daysDiff(aISO, bISO) {
    return Math.round((new Date(bISO) - new Date(aISO)) / 86400000);
  }

  function dayLabel(iso) {
    const today = DB.todayISO();
    if (iso === today) return '今天';
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (iso === DB.toISO(y)) return '昨天';
    const parts = iso.split('-');
    return parseInt(parts[0], 10) + '年' + parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日';
  }

  function viewLogRows(logs) {
    let html = '';
    let lastDay = '';
    logs.forEach(function (log) {
      const d = new Date(log.viewedAt);
      const day = DB.toISO(d);
      if (day !== lastDay) {
        const n = logs.filter(function (x) { return DB.toISO(new Date(x.viewedAt)) === day; }).length;
        html += '<div class="section-title"><span>' + esc(dayLabel(day)) + '</span><span class="count">' + n + ' 次</span></div>';
        lastDay = day;
      }
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const kind = Parser.kindOf(log.name || '');
      html += '<button class="row-item neu press" data-view-doc="' + log.docId + '" type="button">' +
        '<span class="r-name">' + esc(log.name) + '</span>' +
        '<span class="r-series"><span class="badge muted">' + hm + '</span></span>' +
        '<span class="r-dates">' +
        '<span>再次点击可直接查看</span>' +
        '<span class="vl-kind">' + UI.icon(UI.kindIcon(kind)) + esc((log.ext || '').toUpperCase()) + '</span>' +
        '</span>' +
        '</button>';
    });
    return html;
  }

  function segChipsHtml() {
    return '<div class="chip-scroll" style="margin-top:4px"><div class="chips" data-chips><span class="chip-bg"></span>' +
      '<button class="chip' + (state.events.seg !== 'views' ? ' on' : '') + '" data-ev-seg="cycle" type="button">周期事件</button>' +
      '<button class="chip' + (state.events.seg === 'views' ? ' on' : '') + '" data-ev-seg="views" type="button">查看记录</button>' +
      '</div></div>';
  }

  function periodicSeries() {
    return state.series.filter(function (s) {
      return s.cycle && s.cycle !== 'none' && s.included !== false;
    });
  }

  async function eventsHtml() {
    if (state.events.seg === 'views') {
      const logs = await DB.listViewLogs(state.events.visible);
      const total = await DB.countViewLogs();
      return '<div class="topbar"><div>' +
        '<p class="meta">每次打开文件自动记录，按日期排列</p>' +
        '<p class="sub">' + (total ? '共 ' + total + ' 条 · 新→旧' : '还没有记录') + '</p>' +
        '</div></div>' +
        segChipsHtml() +
        '<div class="rows" style="margin-top:6px">' + (logs.length ? viewLogRows(logs) : emptyBlock('还没有查看记录', '在文件详情里点「查看文件」后，这里会按日期列出每次查看')) + '</div>' +
        (total > logs.length ? '<div style="padding:8px 0;text-align:center"><button class="btn" data-more-viewlogs type="button">加载更早的记录</button></div>' : '');
    }
    return cycleEventsHtml(DB.todayISO());
  }

  function evTag(ev, todayStr) {
    if (ev.status === 'done') return '<span class="ev-tag ok">已完成</span>';
    if (ev.status === 'overdue') {
      return '<span class="ev-tag over">逾期 ' + Math.max(1, daysDiff(ev.endISO, todayStr)) + ' 天</span>';
    }
    if (ev.dueIn === 0) return '<span class="ev-tag warn">今日截止</span>';
    if (ev.remind) return '<span class="ev-tag warn">剩 ' + ev.dueIn + ' 天</span>';
    return '<span class="ev-tag">剩 ' + ev.dueIn + ' 天</span>';
  }

  function evCardHtml(ev, todayStr, idx) {
    const tag = evTag(ev, todayStr);
    const animStyle = idx != null ? ' style="animation-delay:' + Math.min(idx * 70, 420) + 'ms" data-anim="todo"' : '';
    if (ev.status === 'done') {
      const extra = ev.docs.length > 1 ? ' 等 ' + ev.docs.length + ' 份' : '';
      return '<button class="ev-card todo-card neu press todo-anim" data-open="' + ev.topDoc.id + '"' + animStyle + ' type="button">' +
        '<span class="todo-row">' +
        '<span class="icon-box done todo-ico">' + UI.icon('check') + '</span>' +
        '<span class="todo-body">' +
        '<span class="ev-name todo-title">' + esc(ev.seriesName) + '</span>' +
        '<span class="todo-tags">' +
        '<span class="todo-tag tt-kind">' + UI.icon('flag') + '<em>' + esc(ev.label) + '</em></span>' +
        '<span class="todo-tag tt-time">' + UI.icon('clock') + '<em class="ev-period">' +
        esc(ev.topDoc.name) + extra + '</em></span>' +
        '</span>' +
        '</span>' +
        '<span class="ev-side">' + tag + '</span>' +
        '</span>' +
        '</button>';
    }
    const cls = ev.status === 'overdue' ? ' over' : (ev.remind || ev.dueIn <= 1 ? ' warn' : '');
    const hint = ev.status === 'overdue'
      ? '补归档一份「' + ev.seriesName + '」文档即可完成'
      : '归档一份「' + ev.seriesName + '」文档后自动完成';
    const alertCls = (ev.status === 'overdue' || ev.remind) ? ' todo-alert' : '';
    return '<div class="ev-card todo-card neu todo-anim' + alertCls + '"' + animStyle + '>' +
      '<div class="todo-row">' +
      '<span class="icon-box' + cls + ' todo-ico">' + UI.icon('clock') + '</span>' +
      '<div class="todo-body">' +
      '<p class="ev-name todo-title">' + esc(ev.seriesName) + '</p>' +
      '<div class="todo-tags">' +
      '<span class="todo-tag tt-time" title="时间">' + UI.icon('clock') + '<em class="ev-period">截止 ' + esc(UI.fmtDate(ev.endISO)) + '</em></span>' +
      '<span class="todo-tag tt-kind" title="事件">' + UI.icon('flag') + '<em>' + esc(ev.label) + '</em></span>' +
      '</div>' +
      '<span class="ev-hint">' + esc(hint) + '</span>' +
      '</div>' +
      '<span class="ev-side">' + tag + '</span>' +
      '</div>' +
      '</div>';
  }

  function cycleEventsHtml(todayStr) {
    const periodic = periodicSeries();

    if (!periodic.length) {
      return '<div class="topbar"><div>' +
        '<p class="meta">根据文档记录自动推导</p>' +
        '</div></div>' +
        segChipsHtml() +
        emptyBlock('还没有周期事件', '在设置里编辑系列模板，开启「每周一份」或「每月一份」后，每个周期会自动生成一条事件，归档对应文档即完成') +
        '<div style="text-align:center;margin-top:-20px"><button class="btn primary" data-ev-new-series type="button">' + UI.icon('plus') + '新建系列模板</button></div>';
    }

    const all = Events.compute(state.docs, state.series, todayStr);
    const filtered = state.events.seriesId
      ? all.filter(function (e) { return e.seriesId === state.events.seriesId; })
      : all;
    const pendingList = filtered.filter(function (e) { return e.status !== 'done'; });
    const doneList = filtered.filter(function (e) { return e.status === 'done'; });
    const alertCount = all.filter(function (e) { return e.status === 'overdue' || e.remind; }).length;

    const chips = '<button class="chip' + (!state.events.seriesId ? ' on' : '') + '" data-ev-series="" type="button">全部系列</button>' +
      periodic.map(function (s) {
        return '<button class="chip' + (state.events.seriesId === s.id ? ' on' : '') + '" data-ev-series="' + s.id + '" type="button">' + esc(s.name) + '</button>';
      }).join('');

    const summary = '<div class="ev-summary neu">' +
      '<div class="ev-sum"><div class="n">' + pendingList.length + '</div><div class="t">待完成</div></div>' +
      '<div class="ev-sum' + (alertCount ? ' alert' : '') + '"><div class="n">' + alertCount + '</div><div class="t">需留意</div></div>' +
      '<div class="ev-sum"><div class="n">' + doneList.length + '</div><div class="t">已完成</div></div>' +
      '</div>';

    const pendingHtml = pendingList.length
      ? pendingList.map(function (e, i) { return evCardHtml(e, todayStr, i); }).join('')
      : emptyBlock('没有待完成的事件', '当前筛选下的周期都已归档文档');
    const doneHtml = doneList.length
      ? doneList.map(function (e) { return evCardHtml(e, todayStr); }).join('')
      : emptyBlock('还没有完成记录', '归档对应周期的文档后，完成情况会出现在这里');

    return '<div class="topbar"><div>' +
      '<p class="meta">根据文档记录自动推导</p>' +
      '<p class="sub">' + periodic.length + ' 个周期系列 · 待完成 ' + pendingList.length + ' · 已完成 ' + doneList.length + '</p>' +
      '</div></div>' +
      segChipsHtml() +
      summary +
      '<div class="chip-scroll" style="margin-top:14px"><div class="chips" data-chips><span class="chip-bg"></span>' + chips + '</div></div>' +
      '<div class="section-title"><span>待完成</span><span class="count">' + pendingList.length + ' 个</span></div>' +
      '<div class="doc-list">' + pendingHtml + '</div>' +
      '<div class="section-title"><span>已完成</span><span class="count">' + doneList.length + ' 个</span></div>' +
      '<div class="doc-list">' + doneHtml + '</div>';
  }

  /* ---------- 设置 ---------- */

  async function settingsHtml() {
    const info = await DB.storageInfo();
    const pct = Math.min(100, Math.round(info.ratio * 100));
    const warn = info.ratio >= 0.8;
    let ocr = { total: 0, done: 0, empty: 0, failed: 0, pending: 0, none: 0, chars: 0 };
    let os = { enabled: true, cnOnly: false };
    if (window.OCRJob) {
      try {
        os = await OCRJob.loadSettings();
        ocr = await OCRJob.stats();
      } catch (e) { /* 统计失败不影响设置页 */ }
    }
    const typeRows = [
      ['文档', info.byType.doc, '#6C8BF5'],
      ['表格', info.byType.sheet, '#3F9E72'],
      ['PDF', info.byType.pdf, '#D2705F'],
      ['图片', info.byType.image, '#B08350'],
      ['其他', info.byType.other, '#A6AFC2']
    ].filter(function (t) { return t[1] > 0; });

    const legend = typeRows.map(function (t) {
      return '<span><i style="background:' + t[2] + '"></i>' + t[0] + ' ' + UI.fmtSize(t[1]) + '</span>';
    }).join('');

    return '<div class="topbar"><div>' +
      '<p class="meta">容量、模板与数据管理</p>' +
      '</div></div>' +

      '<div class="capacity neu">' +
      '<div class="cap-head"><div><span class="cap-num">' + UI.fmtSize(info.usage) + '</span><span class="cap-unit"> 已用</span></div>' +
      '<span class="cap-unit">' + (info.quota ? '配额 ' + UI.fmtSize(info.quota) : '配额未知') + '</span></div>' +
      '<div class="bar' + (warn ? ' warn' : '') + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="cap-legend">' + (legend || '<span>暂无文件占用</span>') + '</div>' +
      (warn ? '<div class="inline-hint warn" style="margin-top:10px">容量接近上限，建议导出备份后清理较早的文件</div>' : '') +
      '</div>' +

      '<div class="section-title"><span>文档管理</span><span class="count">' + info.count + ' 份</span></div>' +
      '<div class="setting-group">' +
      '<button class="setting-item neu press" data-bulk-manage type="button">' +
      '<span class="icon-box">' + UI.icon('trash') + '</span>' +
      '<span class="s-main"><span class="s-title">批量管理</span><span class="s-desc">勾选后删除，支持全选</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<button class="setting-item neu press" data-clear-all type="button">' +
      '<span class="icon-box other">' + UI.icon('database') + '</span>' +
      '<span class="s-main"><span class="s-title">清空全部数据</span><span class="s-desc">删除所有文件与记录，操作不可撤销</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '</div>' +

      '<div class="section-title"><span>系列模板</span><span class="count">' + state.series.length + ' 个</span></div>' +
      '<div class="setting-group">' +
      state.series.map(function (s) {
        const cycleInfo = s.cycle === 'week' ? ' · 每周一份' : (s.cycle === 'month' ? ' · 每月一份' : '');
        const offInfo = (s.cycle && s.included === false) ? ' · 不参与事件统计' : '';
        return '<button class="setting-item neu press" data-edit-series="' + s.id + '" type="button">' +
          '<span class="icon-box">' + UI.icon('template') + '</span>' +
          '<span class="s-main"><span class="s-title">' + esc(s.name) + '</span><span class="s-desc">' + (s.fields || []).length + ' 个字段：' + (s.fields || []).map(function (f) { return esc(f.label); }).join('、') + cycleInfo + offInfo + '</span></span>' +
          '<span class="chev">' + UI.icon('chev') + '</span>' +
          '</button>';
      }).join('') +
      '<button class="setting-item neu press" data-new-series type="button">' +
      '<span class="icon-box">' + UI.icon('plus') + '</span>' +
      '<span class="s-main"><span class="s-title">新建系列模板</span><span class="s-desc">定义字段，统计表按字段生成</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '</div>' +

      '<div class="section-title"><span>备份与恢复</span></div>' +
      '<div class="setting-group">' +
      '<button class="setting-item neu press" data-export-backup type="button">' +
      '<span class="icon-box">' + UI.icon('download') + '</span>' +
      '<span class="s-main"><span class="s-title">导出备份</span><span class="s-desc">记录与文件本体打包成一个 zip</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<button class="setting-item neu press" data-import-backup type="button">' +
      '<span class="icon-box">' + UI.icon('upload') + '</span>' +
      '<span class="s-main"><span class="s-title">恢复备份</span><span class="s-desc">选择 zip 文件导入，可合并或覆盖</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '</div>' +

      '<div class="section-title"><span>局域网同步</span></div>' +
      '<div class="setting-group">' +
      '<button class="setting-item neu press" data-sync-open type="button">' +
      '<span class="icon-box">' + UI.icon('database') + '</span>' +
      '<span class="s-main"><span class="s-title">与另一台设备直连</span><span class="s-desc">同一 WiFi 下扫码配对，电脑资料与待办实时同步到手机，不经过服务器；手机端也可从左上角菜单「扫码连接电脑」直接进入</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<button class="setting-item neu press" data-import-open type="button">' +
      '<span class="icon-box">' + UI.icon('file') + '</span>' +
      '<span class="s-main"><span class="s-title">从手机导入文件</span><span class="s-desc">选取本机文件归档，或导入电脑导出的备份 zip</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '</div>' +

      '<div class="section-title"><span>图片文字识别</span><span class="count">' +
      (ocr.total ? '已识别 ' + ocr.done + ' / ' + ocr.total + ' 张' : '暂无图片') + '</span></div>' +
      '<div class="setting-group">' +
      '<button class="setting-item neu press" data-ocr-toggle type="button">' +
      '<span class="icon-box">' + UI.icon('search') + '</span>' +
      '<span class="s-main"><span class="s-title">归档后自动识别图片文字</span>' +
      '<span class="s-desc">识别结果参与全文检索和关键词关联；识别在本机运行，图片不出设备</span></span>' +
      '<span class="switch' + (os.enabled ? ' on' : '') + '"><i></i></span>' +
      '</button>' +
      '<button class="setting-item neu press" data-ocr-lang type="button">' +
      '<span class="icon-box">' + UI.icon('template') + '</span>' +
      '<span class="s-main"><span class="s-title">识别语言</span>' +
      '<span class="s-desc">' + (os.cnOnly ? '仅中文 · 模型约 1.7MB，识别更快' : '中文 + 英文 · 模型约 3.7MB，中英混排更准') + '</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<button class="setting-item neu press" data-ocr-run type="button">' +
      '<span class="icon-box">' + UI.icon('spark') + '</span>' +
      '<span class="s-main"><span class="s-title">' + (ocr.done ? '重新识别全部图片' : '识别全部图片') + '</span>' +
      '<span class="s-desc">' + (OCRJob && OCRJob.pending() ? '队列中还有 ' + OCRJob.pending() + ' 张待处理' : (ocr.done ? '按当前语言重新识别，覆盖已识别的文字' : '把已归档的图片逐张识别，可随时停止')) + '</span></span>' +
      '<span class="chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      (ocr.chars
        ? '<button class="setting-item neu press" data-ocr-clear type="button">' +
        '<span class="icon-box other">' + UI.icon('trash') + '</span>' +
        '<span class="s-main"><span class="s-title">清除识别文字</span>' +
        '<span class="s-desc">删除全部识别文本（共 ' + ocr.chars + ' 字），图片本身保留</span></span>' +
        '<span class="chev">' + UI.icon('chev') + '</span>' +
        '</button>'
        : '') +
      '</div>' +
      '<div class="notice info" style="margin-top:10px">识别引擎与语言模型随应用一起放在本机，' +
      '第一次识别时加载（合计约 6~8MB，之后离线可用，建议在 WiFi 下做第一次）。' +
      '<strong>图片与识别结果都不会上传</strong>，也不经过任何服务器。</div>' +
      '<div class="notice info" style="margin-top:10px">印刷体、截图、表格里的文字识别效果较好；手写体、艺术字、模糊或倾斜的照片准确率有限，' +
      '可以在查看器里对照原图核对识别结果。</div>' +

      '<div class="section-title"><span>数据安全</span></div>' +
      '<div class="notice">数据保存在这台设备的浏览器里，正常关闭、重开都不会丢。' +
      '<strong>清除浏览器数据、卸载浏览器、无痕模式、更换设备会导致数据丢失</strong>，备份文件是唯一兜底，建议定期导出。</div>' +
      '<div class="notice info" style="margin-top:10px">图片中的文字由本机识别后存进这条记录，保存在本机数据库里；' +
      '可以把识别文字单独清除，也可以随文件一起删除。识别过程不联网，不会把照片传给任何第三方。</div>' +

      '<div class="section-title"><span>关于</span></div>' +
      '<div class="notice info">工作文件 · 本地档案版 v2.3 · 数据不上传，无账号，无云端。' +
      '<br>可添加到手机主屏幕，像应用一样全屏使用。</div>';
  }

  /* ---------- 抽屉表单 ---------- */

  function fieldRowHtml(f, value) {
    const type = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
    const val = value == null ? '' : value;
    return '<div class="field"><label for="fld-' + f.key + '">' + esc(f.label) + '</label>' +
      '<input class="input" id="fld-' + f.key + '" data-field="' + f.key + '" type="' + type + '" value="' + esc(val) + '" placeholder="' + (type === 'number' ? '填数字' : '选填') + '"></div>';
  }

  function formHtml(doc, mode) {
    const isEdit = mode === 'edit';
    const kind = Parser.kindOf(doc.name || '');
    const seriesOptions = '<option value="">不归入系列</option>' + state.series.map(function (s) {
      return '<option value="' + s.id + '"' + (doc.seriesId === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('') + '<option value="__new__">＋ 新建系列…</option>';

    const folderOptions = '<option value="">不放入文件夹</option>' + orderedFolders().map(function (o) {
      const pad = o.depth > 0 ? '└ '.repeat(1) : '';
      const prefix = o.depth > 0 ? '　'.repeat(Math.min(o.depth, 3) - 1) + pad : '';
      return '<option value="' + o.f.id + '"' + (doc.folderId === o.f.id ? ' selected' : '') + '>' +
        prefix + esc(o.f.name) + '</option>';
    }).join('') + '<option value="__newfolder__">＋ 新建文件夹…</option>';

    const s = doc.seriesId ? seriesById(doc.seriesId) : null;
    const dynamicFields = s ? (s.fields || []).map(function (f) {
      return fieldRowHtml(f, doc.fields ? doc.fields[f.key] : '');
    }).join('') : '';
    let parseHint = doc.extractStatus === 'done'
      ? ' · 已提取 ' + (doc.fullText || '').length + ' 字'
      : (doc.extractStatus === 'failed' ? ' · 正文未提取'
        : (doc.extractStatus === 'skipped'
          ? (kind === 'image' ? ' · 图片无文字层' : ' · 暂不提取正文') : ''));
    if (kind === 'image') {
      const st = doc.ocrStatus || 'none';
      if (st === 'done') parseHint = ' · 已识别文字 ' + (doc.ocrChars || (doc.ocrText || '').length) + ' 字';
      else if (st === 'pending') parseHint = ' · 文字识别中';
      else if (st === 'failed') parseHint = ' · 文字识别失败';
      else if (st === 'empty') parseHint = ' · 未识别到文字';
      else parseHint = ' · 文字待识别';
    }
    if (doc.seq != null) parseHint += ' · 序号 ' + doc.seq;
    if (doc.fileModified) parseHint += ' · 文件时间 ' + UI.fmtDate(DB.toISO(new Date(doc.fileModified)), true);

    return '<div class="form">' +
      '<div class="setting-item neu" style="cursor:default">' +
      '<span class="icon-box ' + kind + '">' + UI.icon(UI.kindIcon(kind)) + '</span>' +
      '<span class="s-main"><span class="s-title">' + esc(doc.name) + '</span>' +
      '<span class="s-desc">' + UI.fmtSize(doc.size) + (doc.ext ? ' · ' + doc.ext.toUpperCase() : '') + parseHint +
      '</span></span></div>' +

      '<div class="field"><label for="docName">文件名称</label>' +
      '<input class="input" id="docName" value="' + esc(doc.name) + '"></div>' +

      '<div class="input-row">' +
      '<div class="field"><label for="fileDate">文件名日期</label>' +
      '<input class="input" id="fileDate" type="date" value="' + esc(doc.fileDate || '') + '">' +
      '<span class="hint">' + (doc.fileDate ? (doc.dateSource === 'name' ? '从文件名识别' : '手动填写') : '未识别，可手动补录') + '</span></div>' +
      '<div class="field"><label for="archiveDate">归档日期</label>' +
      '<input class="input" id="archiveDate" type="date" value="' + esc(doc.archiveDate || DB.todayISO()) + '"></div>' +
      '</div>' +

      '<div class="field"><label for="docFolder">归档到文件夹<span class="hint">用于整理，与统计无关</span></label>' +
      '<select class="input" id="docFolder">' + folderOptions + '</select>' +
      '<div class="series-new" id="folderNew" hidden>' +
      '<div class="series-new-row">' +
      '<input class="input" id="newFolderName" placeholder="文件夹名称，如 2026 秋季学期">' +
      '<button class="btn primary" data-create-folder type="button">新建</button>' +
      '</div>' +
      '<span class="hint">文件夹只负责摆放；要让同批文件出一张统计表，请用上面的「所属系列」</span>' +
      '</div></div>' +

      '<div class="field"><label for="docSeries">所属系列<span class="hint">可直接新建</span></label>' +
      '<select class="input" id="docSeries">' + seriesOptions + '</select>' +
      '<div class="series-new" id="seriesNew" hidden>' +
      '<div class="series-new-row">' +
      '<input class="input" id="newSeriesName" placeholder="新系列名称，如 数学教研">' +
      '<button class="btn primary" data-create-series type="button">新建</button>' +
      '</div>' +
      '<span class="hint">先在设置里新建模板可以定义字段；这里建好的系列，字段可稍后在「个人设置 → 新建系列模板」补充</span>' +
      '</div>' +
      '<span class="hint">' + (state.series.length ? '同系列文档会进入一张统计表' : '还没有模板，可在设置里新建') + '</span></div>' +

      '<div id="fieldZone">' + (dynamicFields ? '<div class="form">' + dynamicFields + '</div>' : '') + '</div>' +

      '<div class="field"><label for="docNote">备注</label>' +
      '<textarea class="input" id="docNote" placeholder="选填">' + esc(doc.note || '') + '</textarea></div>' +

      '<div class="form-actions">' +
      '<button class="btn" data-cancel type="button">取消</button>' +
      '<button class="btn primary" data-save="' + mode + '" type="button">' + (isEdit ? '保存修改' : '归档保存') + '</button>' +
      '</div>' +
      (isEdit ? '<div class="form-actions">' +
        '<button class="btn" data-open-file type="button">' + UI.icon('eye') + '查看文件</button>' +
        '<button class="btn" data-replace type="button">' + UI.icon('upload') + '替换文件</button>' +
        '<button class="btn danger" data-delete type="button">' + UI.icon('trash') + '删除</button>' +
        '</div>' : '') +
      '</div>';
  }

  function collectForm(root, base) {
    const nameEl = root.querySelector('#docName');
    const fileEl = root.querySelector('#fileDate');
    const archEl = root.querySelector('#archiveDate');
    const seriesEl = root.querySelector('#docSeries');
    const folderEl = root.querySelector('#docFolder');
    const noteEl = root.querySelector('#docNote');
    const fields = {};
    UI.$$('[data-field]', root).forEach(function (el) {
      const key = el.getAttribute('data-field');
      if (el.value !== '') fields[key] = el.value;
    });
    return Object.assign({}, base, {
      name: nameEl ? nameEl.value.trim() : base.name,
      fileDate: fileEl ? fileEl.value : base.fileDate,
      archiveDate: archEl ? archEl.value : base.archiveDate,
      seriesId: seriesEl && seriesEl.value ? parseInt(seriesEl.value, 10) : null,
      folderId: folderEl && folderEl.value && folderEl.value.indexOf('__') !== 0
        ? parseInt(folderEl.value, 10) : null,
      note: noteEl ? noteEl.value.trim() : '',
      fields: fields,
      dateSource: base.dateSource === 'name' && fileEl && fileEl.value === base.fileDate ? 'name' : 'manual'
    });
  }

  /* 归档抽屉里就地新建系列：建好后自动选中，并渲染该系列的字段 */
  async function createSeriesInline(body) {
    const nameEl = body.querySelector('#newSeriesName');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) { UI.toast('先填写新系列的名称'); if (nameEl) nameEl.focus(); return null; }
    const dup = state.series.filter(function (s) { return s.name === name; })[0];
    if (dup) {
      UI.toast('已有同名系列，已直接选中');
      state.series = await DB.listSeries();
      return dup.id;
    }
    const id = await DB.addSeries({ name: name, fields: [] });
    state.series = await DB.listSeries();
    UI.toast('已新建系列「' + name + '」', 'ok');
    return id;
  }

  /* ---------- 自定义关键词关联 ---------- */

  function openKwCustom() {
    let picked = (state.kwPinned || []).slice();
    const cands = Keywords.collect(state.docs, 60);

    function chipsHtml() {
      if (!picked.length) {
        return '<p class="kw-tip muted">还没有关联词。从下方候选里点选，或直接输入一个词。</p>';
      }
      return '<div class="kw-chips">' + picked.map(function (w) {
        return '<button class="kw-chip on" data-kw-remove="' + esc(w) + '" type="button">' + esc(w) + UI.icon('close') + '</button>';
      }).join('') + '</div>';
    }

    function candHtml() {
      if (!cands.length) return '<p class="kw-tip muted">文档正文还太少，先直接输入关键词即可。</p>';
      return '<div class="kw-cands">' + cands.map(function (c) {
        const on = picked.indexOf(c.word) >= 0;
        return '<button class="kw-cand' + (on ? ' on' : '') + '" data-kw-toggle="' + esc(c.word) + '" type="button">' +
          esc(c.word) + '<b>' + c.count + '</b></button>';
      }).join('') + '</div>';
    }

    const html =
      '<div class="form">' +
      '<div class="field"><label>已关联的关键词<span class="hint">显示在主页「内容关键词关联」最上方</span></label>' +
      '<div id="kwPicked">' + chipsHtml() + '</div></div>' +

      '<div class="field"><label for="kwNew">手动添加</label>' +
      '<div class="kw-add-row">' +
      '<input class="input" id="kwNew" maxlength="12" placeholder="如：教研、成绩分析" autocomplete="off">' +
      '<button class="btn primary" data-kw-add type="button">添加</button>' +
      '</div><span class="hint">最多 12 个；即使只出现在 1 份文件里也会照常显示</span></div>' +

      '<div class="section-title"><span>从文档里挑</span><span class="count">按出现份数</span></div>' +
      '<div id="kwCands">' + candHtml() + '</div>' +

      '<div class="form-actions">' +
      '<button class="btn" data-kw-cancel type="button">取消</button>' +
      '<button class="btn primary" data-kw-save type="button">保存关联</button>' +
      '</div></div>';

    UI.openDrawer('自定义关键词关联', html, function (body) {
      function repaint() {
        const p = body.querySelector('#kwPicked');
        const c = body.querySelector('#kwCands');
        if (p) p.innerHTML = chipsHtml();
        if (c) c.innerHTML = candHtml();
      }

      function addWord(w) {
        const word = String(w || '').trim().slice(0, 12);
        if (!word) return;
        if (picked.indexOf(word) >= 0) { UI.toast('这个词已经在列表里'); return; }
        if (picked.length >= 12) { UI.toast('最多关联 12 个词'); return; }
        picked.push(word);
        repaint();
      }

      body.addEventListener('click', async function (e) {
        const toggle = e.target.closest('[data-kw-toggle]');
        if (toggle) { addWord(toggle.getAttribute('data-kw-toggle')); return; }

        const rm = e.target.closest('[data-kw-remove]');
        if (rm) {
          const w = rm.getAttribute('data-kw-remove');
          picked = picked.filter(function (x) { return x !== w; });
          repaint();
          return;
        }

        if (e.target.closest('[data-kw-add]')) {
          const input = body.querySelector('#kwNew');
          addWord(input ? input.value : '');
          if (input) { input.value = ''; input.focus(); }
          return;
        }

        if (e.target.closest('[data-kw-cancel]')) { UI.closeDrawer(); return; }

        if (e.target.closest('[data-kw-save]')) {
          await DB.setSetting('kwPinned', picked);
          state.kwPinned = picked.slice();
          UI.closeDrawer();
          await render('home');
          UI.toast(picked.length ? '已关联 ' + picked.length + ' 个关键词' : '已清空自定义关联', 'ok');
        }
      });

      body.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (!e.target.closest('#kwNew')) return;
        e.preventDefault();
        const input = e.target;
        addWord(input.value);
        input.value = '';
      });
    });
  }

  /* ---------- 文件夹：新建 / 重命名 / 删除 ---------- */

  async function createFolder(rawName) {
    const name = String(rawName || '').trim();
    if (!name) { UI.toast('先填写文件夹名称'); return null; }
    const dup = state.folders.filter(function (f) { return f.name === name; })[0];
    if (dup) {
      UI.toast('已有同名文件夹，已直接选中');
      return dup.id;
    }
    const id = await DB.addFolder(name);
    state.folders = await DB.listFolders();
    return id;
  }

  function fillFolderOptions(folderEl, selectedId) {
    if (!folderEl) return;
    const items = orderedFolders().map(function (o) {
      const prefix = o.depth > 0 ? '　'.repeat(Math.min(o.depth, 3) - 1) + '└ ' : '';
      return '<option value="' + o.f.id + '"' + (selectedId === o.f.id ? ' selected' : '') + '>' +
        prefix + esc(o.f.name) + '</option>';
    }).join('');
    folderEl.innerHTML = '<option value="">不放入文件夹</option>' + items + '<option value="__newfolder__">＋ 新建文件夹…</option>';
    folderEl.value = selectedId ? String(selectedId) : '';
  }

  /* 抽屉式编辑器：新建（folder 为空，可指定上级）或重命名 */
  function openFolderEditor(folder, parentId) {
    const isEdit = !!folder;
    const parentName = !isEdit && parentId ? folderPath(parentId) : '';
    const html =
      '<div class="form">' +
      '<div class="field"><label for="folderName">文件夹名称</label>' +
      '<input class="input" id="folderName" maxlength="30" placeholder="如：2026 秋季学期 / 职称材料 / 班级照片" value="' + esc(isEdit ? folder.name : '') + '">' +
      '<span class="hint">' + (parentName
        ? '将建在「' + esc(parentName) + '」里面，成为它的子文件夹；'
        : '文件夹只用于整理摆放，不影响统计表；') + '删除文件夹不会删除里面的文件</span></div>' +
      '<div class="form-actions">' +
      '<button class="btn" data-cancel type="button">取消</button>' +
      '<button class="btn primary" data-folder-save type="button">' + (isEdit ? '保存名称' : '创建文件夹') + '</button>' +
      '</div></div>';

    UI.openDrawer(isEdit ? '重命名文件夹' : (parentName ? '新建子文件夹' : '新建文件夹'), html, function (body) {
      const input = body.querySelector('#folderName');
      if (input) setTimeout(function () { input.focus(); }, 60);

      async function save() {
        const name = input ? input.value.trim() : '';
        if (!name) { UI.toast('先填写文件夹名称'); if (input) input.focus(); return; }
        const dup = state.folders.filter(function (f) {
          return f.name === name && (!isEdit || f.id !== folder.id);
        })[0];
        if (dup) { UI.toast('已有同名文件夹'); return; }
        if (isEdit) {
          await DB.updateFolder(folder.id, { name: name });
          UI.toast('已重命名', 'ok');
        } else {
          const id = await DB.addFolder(name, parentId || null);
          /* 在文件夹里新建子文件夹：留在当前文件夹，立刻能看到新色块；顶层新建才跳进去 */
          state.archive.folder = String(parentId || id);
          UI.toast('已新建文件夹「' + name + '」', 'ok');
        }
        await loadAll();
        UI.closeDrawer();
        await render('archive');
      }

      body.addEventListener('click', async function (e) {
        if (e.target.closest('[data-cancel]')) { UI.closeDrawer(); return; }
        if (e.target.closest('[data-folder-save]')) await save();
      });
      body.addEventListener('keydown', async function (e) {
        if (e.key === 'Enter' && e.target.id === 'folderName') { e.preventDefault(); await save(); }
      });
    });
  }

  /* 移动文件夹：选一个新上级（不能选自己或自己的子文件夹），选「顶层」回到第一级 */
  function openFolderMover(folder) {
    const candidates = state.folders.filter(function (f) {
      return f.id !== folder.id && !isDescendantFolder(f.id, folder.id);
    });
    const curParent = folder.parentId ? folderPath(folder.parentId) : '顶层';

    function listHtml() {
      const rows =
        '<button class="mv-row' + (!folder.parentId ? ' on' : '') + '" data-mv-to="" type="button">' +
        UI.icon('archive') + '<span class="mv-name">顶层（第一级）</span>' +
        (!folder.parentId ? '<span class="mv-cur">当前位置</span>' : '') + '</button>' +
        candidates.map(function (f) {
          const isCur = folder.parentId === f.id;
          return '<button class="mv-row' + (isCur ? ' on' : '') + '" data-mv-to="' + f.id + '" type="button">' +
            UI.icon('folder') + '<span class="mv-name">' + esc(folderPath(f.id)) + '</span>' +
            (isCur ? '<span class="mv-cur">当前位置</span>' : '') + '</button>';
        }).join('');
      return rows || '<p class="kw-tip muted">还没有其他文件夹可以选</p>';
    }

    const html =
      '<div class="form">' +
      '<div class="field"><label>移动「' + esc(folder.name) + '」到<span class="hint">它里面的文件和子文件夹会跟着一起移动</span></label>' +
      '<div class="mv-list" id="mvList">' + listHtml() + '</div></div>' +
      '<div class="form-actions"><button class="btn" data-cancel type="button">取消</button></div>' +
      '</div>';

    UI.openDrawer('移动文件夹', html, function (body) {
      body.addEventListener('click', async function (e) {
        if (e.target.closest('[data-cancel]')) { UI.closeDrawer(); return; }
        const row = e.target.closest('[data-mv-to]');
        if (!row) return;
        const to = row.getAttribute('data-mv-to');
        const target = to === '' ? null : parseInt(to, 10);
        if ((folder.parentId || null) === target) { UI.toast('它已经在这个位置了'); return; }
        try {
          await DB.moveFolder(folder.id, target);
          UI.toast(target ? '已移动到「' + folderPath(target) + '」' : '已移动到顶层', 'ok');
          await loadAll();
          UI.closeDrawer();
          await render('archive');
        } catch (err) {
          UI.toast(err.message || '移动失败', 'err');
        }
      });
    });
  }

  async function removeFolder(id) {
    const f = folderById(id);
    if (!f) return;
    const n = folderDeepCount(id);
    const kids = folderKids(id).length;
    const ok = await UI.confirm({
      title: '删除文件夹「' + f.name + '」',
      message: (n ? '里面共 ' + n + ' 份文件（含子文件夹）会退回「未归类」，文件本身不会被删除。' : '文件夹为空，删除后不可恢复。') +
        (kids ? '它的 ' + kids + ' 个子文件夹会上移一级。' : ''),
      okText: '删除文件夹',
      cancelText: '再想想',
      danger: true
    });
    if (!ok) return;
    await DB.deleteFolder(id);
    state.archive.folder = 'all';
    await loadAll();
    await render('archive');
    UI.toast('已删除文件夹', 'ok');
  }

  function fillSeriesOptions(seriesEl, selectedId) {    if (!seriesEl) return;
    const head = '<option value="">不归入系列</option>';
    const items = state.series.map(function (s) {
      return '<option value="' + s.id + '"' + (selectedId === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    seriesEl.innerHTML = head + items + '<option value="__new__">＋ 新建系列…</option>';
    seriesEl.value = selectedId ? String(selectedId) : '';
  }

  function paintFieldZone(body, seriesId) {
    const zone = body.querySelector('#fieldZone');
    if (!zone) return;
    const s = seriesId ? seriesById(seriesId) : null;
    const current = {};
    UI.$$('[data-field]', body).forEach(function (el) { current[el.getAttribute('data-field')] = el.value; });
    zone.innerHTML = s && (s.fields || []).length
      ? '<div class="form">' + (s.fields || []).map(function (f) {
        return fieldRowHtml(f, current[f.key] || '');
      }).join('') + '</div>'
      : '';
  }

  async function openDocForm(doc, mode) {
    UI.openDrawer(mode === 'edit' ? '文件详情' : '归档新文件', formHtml(doc, mode), function (body) {
      const seriesEl = body.querySelector('#docSeries');
      const newBox = body.querySelector('#seriesNew');
      if (seriesEl) {
        seriesEl.addEventListener('change', function () {
          if (seriesEl.value === '__new__') {
            if (newBox) newBox.hidden = false;
            const input = body.querySelector('#newSeriesName');
            if (input) setTimeout(function () { input.focus(); }, 40);
            return;
          }
          if (newBox) newBox.hidden = true;
          paintFieldZone(body, parseInt(seriesEl.value, 10) || null);
        });
      }

      /* 新系列名称里按回车＝点「新建」 */
      body.addEventListener('keydown', async function (e) {
        if (e.key !== 'Enter') return;
        if (e.target.closest('#newFolderName')) {
          e.preventDefault();
          const fid = await createFolder(e.target.value);
          if (!fid) return;
          fillFolderOptions(body.querySelector('#docFolder'), fid);
          const fbox = body.querySelector('#folderNew');
          if (fbox) fbox.hidden = true;
          return;
        }
        if (!e.target.closest('#newSeriesName')) return;
        e.preventDefault();
        const id = await createSeriesInline(body);
        if (!id) return;
        fillSeriesOptions(seriesEl, id);
        if (newBox) newBox.hidden = true;
        paintFieldZone(body, id);
      });

      /* 归档到文件夹：下拉里选「＋ 新建文件夹…」就地展开输入框 */
      const folderEl = body.querySelector('#docFolder');
      const fNewBox = body.querySelector('#folderNew');
      if (folderEl) {
        folderEl.addEventListener('change', function () {
          if (folderEl.value === '__newfolder__') {
            if (fNewBox) fNewBox.hidden = false;
            const fi = body.querySelector('#newFolderName');
            if (fi) setTimeout(function () { fi.focus(); }, 40);
            return;
          }
          if (fNewBox) fNewBox.hidden = true;
        });
      }

      body.addEventListener('click', async function (e) {
        if (e.target.closest('[data-cancel]')) { UI.closeDrawer(); return; }

        if (e.target.closest('[data-create-series]')) {
          const id = await createSeriesInline(body);
          if (!id) return;
          fillSeriesOptions(seriesEl, id);
          if (newBox) newBox.hidden = true;
          paintFieldZone(body, id);
          return;
        }

        if (e.target.closest('[data-create-folder]')) {
          const fid = await createFolder(body.querySelector('#newFolderName') ? body.querySelector('#newFolderName').value : '');
          if (!fid) return;
          fillFolderOptions(body.querySelector('#docFolder'), fid);
          const fbox = body.querySelector('#folderNew');
          if (fbox) fbox.hidden = true;
          return;
        }

        const saveBtn = e.target.closest('[data-save]');
        if (saveBtn) {
          if (seriesEl && seriesEl.value === '__new__') {
            const id = await createSeriesInline(body);
            if (!id) return;
            fillSeriesOptions(seriesEl, id);
            if (newBox) newBox.hidden = true;
            paintFieldZone(body, id);
          }
          if (folderEl && folderEl.value === '__newfolder__') {
            const fnameEl = body.querySelector('#newFolderName');
            const fid = await createFolder(fnameEl ? fnameEl.value : '');
            if (!fid) return;
            fillFolderOptions(folderEl, fid);
            const fbox = body.querySelector('#folderNew');
            if (fbox) fbox.hidden = true;
          }
          const data = collectForm(body, doc);
          if (!data.name) { UI.toast('文件名不能为空'); return; }
          if (!data.archiveDate) { UI.toast('归档日期不能为空'); return; }
          /* 新归档且没选文件夹：标题里含文件夹名就自动放入 */
          if (mode !== 'edit' && !data.folderId) data.folderId = matchFolderByName(data.name);
          saveBtn.disabled = true;
          try {
            const beforeEvents = Events.compute(state.docs, state.series, DB.todayISO());
            let newId = null;
            if (mode === 'edit') {
              await DB.updateDocument(doc.id, data);
              UI.toast('已保存', 'ok');
            } else {
              newId = await DB.addDocument(data);
              UI.toast('已归档', 'ok');
            }
            await loadAll();
            const newly = Events.newlyDone(
              beforeEvents,
              Events.compute(state.docs, state.series, DB.todayISO())
            );
            UI.closeDrawer();
            await window.App.refresh();
            if (newId) queueOcrFor(newId, data.name);
            if (newly.length) {
              UI.celebrate('「' + newly[0].seriesName + '」已完成', newly[0].label + ' · 本周期归档齐了');
            }
          } catch (err) {
            saveBtn.disabled = false;
            UI.toast(err && err.name === 'QuotaError' ? err.message : ('保存失败：' + (err && err.message ? err.message : '未知错误')), 'err');
          }
          return;
        }

        if (e.target.closest('[data-open-file]')) {
          Viewer.open(doc);
          return;
        }

        if (e.target.closest('[data-replace]')) {
          const input = document.createElement('input');
          input.type = 'file';
          input.style.display = 'none';
          document.body.appendChild(input);
          input.onchange = async function () {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
              await DB.assertSpace(file.size);
              const parsed = await Parser.extractText(file);
              const seqInfo = Parser.seqInfo(file.name);
              await DB.updateDocument(doc.id, {
                name: file.name,
                ext: Parser.extOf(file.name),
                mime: file.type || '',
                size: file.size,
                blob: file,
                seq: seqInfo.seq,
                seqTag: seqInfo.tag,
                fileModified: file.lastModified || 0,
                fullText: parsed.text,
                extractStatus: parsed.status,
                ocrText: '',
                ocrStatus: 'none',
                ocrChars: 0
              });
              UI.toast('文件已替换', 'ok');
              UI.closeDrawer();
              await window.App.refresh();
              queueOcrFor(doc.id, file.name);
            } catch (err) {
              UI.toast(err && err.name === 'QuotaError' ? err.message : '替换失败', 'err');
            }
          };
          input.click();
          return;
        }

        if (e.target.closest('[data-delete]')) {
          const ok = await UI.confirm({
            title: '删除这份文件？',
            message: '「' + esc(doc.name) + '」的文件本体和记录会一起删除，无法恢复。',
            okText: '删除',
            danger: true
          });
          if (!ok) return;
          await DB.deleteDocument(doc.id);
          UI.closeDrawer();
          UI.toast('已删除', 'ok');
          await window.App.refresh();
        }
      });
    });
  }

  function newDocTemplate(file, parsedDate, parsed) {
    const info = Parser.seqInfo(file.name);
    return {
      name: file.name,
      ext: Parser.extOf(file.name),
      mime: file.type || '',
      size: file.size,
      blob: file,
      archiveDate: DB.todayISO(),
      fileDate: parsedDate ? parsedDate.date : '',
      dateSource: parsedDate ? 'name' : 'manual',
      fullText: parsed ? parsed.text : '',
      extractStatus: parsed ? parsed.status : 'pending',
      seq: info.seq,
      seqTag: info.tag,
      fileModified: file.lastModified || 0,
      seriesId: null,
      /* 标题里含文件夹名时自动归档，如「期末材料清单.xlsx」自动进「期末材料」 */
      folderId: matchFolderByName(file.name),
      fields: {},
      note: ''
    };
  }

  /* ---------- 压缩包：导入时自动解包（zip 本体不入库） ---------- */

  const ZIP_MAX_ENTRY = 40 * 1024 * 1024;   /* 单个成员上限 */
  const ZIP_MAX_TOTAL = 300 * 1024 * 1024;  /* 解压后总量上限 */
  const ZIP_MAX_FILES = 200;                /* 最多展开多少个文件 */
  const ZIP_SKIP_EXT = ['exe', 'dll', 'msi', 'bat', 'cmd', 'sh', 'app', 'apk', 'dmg', 'iso', 'scr', 'jar'];

  function isJunkEntry(path) {
    return /(^|\/)__MACOSX\//i.test(path) || /(^|\/)\._/.test(path) ||
      /(^|\/)\.DS_Store$/i.test(path) || /(^|\/)Thumbs\.db$/i.test(path) ||
      /~\$/.test(path) || /(^|\/)\.git\//i.test(path);
  }

  function entryBaseName(path) {
    const parts = String(path).split('/');
    return parts[parts.length - 1] || String(path);
  }

  function mimeOfName(name) {
    const map = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pdf: 'application/pdf',
      txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv',
      doc: 'application/msword', xls: 'application/vnd.ms-excel',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff'
    };
    return map[Parser.extOf(name)] || 'application/octet-stream';
  }

  /* 把列表里的 .zip 展开成内部文件，其余文件原样保留 */
  async function expandArchives(list) {
    const out = [];
    const notes = [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      if (Parser.extOf(file.name) !== 'zip') { out.push(file); continue; }
      if (!window.JSZip) { notes.push(file.name + '：缺少解压组件，已跳过'); continue; }
      UI.progress(true, 15, '正在解压「' + file.name + '」');
      try {
        const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
        /* 应用自己的备份包有 data.json + manifest.json，不能当普通压缩包摊开 */
        if (zip.file('data.json') && zip.file('manifest.json')) {
          notes.push(file.name + ' 是本应用的备份包，请到「设置 → 备份与恢复」里导入');
          continue;
        }
        const names = Object.keys(zip.files).filter(function (p) {
          return !zip.files[p].dir && !isJunkEntry(p);
        });
        let picked = 0;
        let skipped = 0;
        let bytes = 0;
        const used = {};
        for (let j = 0; j < names.length; j++) {
          const path = names[j];
          if (picked >= ZIP_MAX_FILES || ZIP_SKIP_EXT.indexOf(Parser.extOf(path)) >= 0) { skipped++; continue; }
          let blob;
          try { blob = await zip.files[path].async('blob'); } catch (e) { skipped++; continue; }
          if (!blob || !blob.size || blob.size > ZIP_MAX_ENTRY || bytes + blob.size > ZIP_MAX_TOTAL) {
            skipped++;
            continue;
          }
          bytes += blob.size;
          /* 不同目录下可能有同名文件，重名时补序号，避免互相覆盖 */
          let name = entryBaseName(path);
          if (used[name]) {
            used[name] += 1;
            const dot = name.lastIndexOf('.');
            name = (dot > 0 ? name.slice(0, dot) : name) + ' (' + used[name] + ')' + (dot > 0 ? name.slice(dot) : '');
          } else {
            used[name] = 1;
          }
          out.push(new File([blob], name, { type: mimeOfName(name) }));
          picked++;
          if (j % 8 === 0) UI.progress(true, 15 + Math.round(j / names.length * 75), '正在解压 ' + picked + ' 个文件…');
        }
        if (picked) {
          notes.push(file.name + ' 解出 ' + picked + ' 个文件' + (skipped ? '（跳过 ' + skipped + ' 个：空文件、超体积或可执行文件）' : ''));
        } else {
          notes.push(file.name + ' 内没有可归档的文件');
        }
      } catch (e) {
        notes.push(file.name + ' 无法解压（' + ((e && e.message) || '文件可能已加密或损坏') + '）');
      }
    }
    UI.progress(false);
    return { files: out, notes: notes };
  }

  async function handleFiles(files) {
    let list = Array.prototype.slice.call(files || []);
    if (!list.length) return;

    /* 压缩包在导入阶段就摊开，不把 zip 本体存进库 */
    const hasZip = list.some(function (f) { return Parser.extOf(f.name) === 'zip'; });
    if (hasZip) {
      const res = await expandArchives(list);
      if (res.notes.length) UI.toast(res.notes.join('；'), res.files.length ? 'ok' : 'err');
      list = res.files;
      if (!list.length) return;
    }

    if (list.length === 1) {
      const file = list[0];
      UI.progress(true, 12, '正在读取「' + file.name + '」');
      const parsedDate = Parser.parseDateFromName(file.name);
      const parsed = await Parser.extractText(file);
      UI.progress(false);
      await openDocForm(newDocTemplate(file, parsedDate, parsed), 'add');
      return;
    }

    /* 多文件上传：先选一个目标文件夹（可交给按名称自动匹配），一次归入同一目录 */
    openBatchArchive(list);
  }

  /* 批量上传确认页：列出所选文件 + 统一选目标文件夹 + 确认归档 */
  function openBatchArchive(list) {
    function fileRows() {
      return list.map(function (f, i) {
        return '<div class="ba-row"><span class="ba-idx">' + (i + 1) + '</span>' +
          '<span class="ba-name">' + esc(f.name) + '</span>' +
          '<span class="ba-size">' + UI.fmtSize(f.size) + '</span></div>';
      }).join('');
    }

    const html =
      '<div class="form">' +
      '<div class="field"><label>已选择 ' + list.length + ' 份文件</label>' +
      '<div class="ba-list">' + fileRows() + '</div>' +
      '<span class="hint">这些文件会归入下面同一个文件夹</span></div>' +

      '<div class="field"><label for="baFolder">归入文件夹</label>' +
      '<select class="input" id="baFolder">' +
      '<option value="auto">按文件名自动匹配（推荐）</option>' +
      '<option value="">不放入文件夹</option>' +
      orderedFolders().map(function (o) {
        const prefix = o.depth > 0 ? '　'.repeat(Math.min(o.depth, 3) - 1) + '└ ' : '';
        return '<option value="' + o.f.id + '">' + prefix + esc(folderPath(o.f.id)) + '</option>';
      }).join('') +
      '</select>' +
      '<span class="hint">自动匹配：文件名里含文件夹名称的文字（如「期末材料清单」→「期末材料」）就归入该文件夹</span>' +
      '</div>' +

      '<div class="form-actions">' +
      '<button class="btn" data-ba-cancel type="button">取消</button>' +
      '<button class="btn primary" data-ba-ok type="button">归档 ' + list.length + ' 份</button>' +
      '</div></div>';

    UI.openDrawer('批量归档', html, function (body) {
      body.addEventListener('click', async function (e) {
        if (e.target.closest('[data-ba-cancel]')) { UI.closeDrawer(); return; }
        if (!e.target.closest('[data-ba-ok]')) return;

        const sel = body.querySelector('#baFolder');
        const mode = sel ? sel.value : 'auto';
        const fixed = mode !== 'auto' && mode !== '' ? parseInt(mode, 10) : null;
        const useAuto = mode === 'auto';
        const okBtn = e.target.closest('[data-ba-ok]');
        okBtn.disabled = true;

        let okN = 0;
        let failN = 0;
        let autoN = 0;
        const newIds = [];
        const beforeEvents = Events.compute(state.docs, state.series, DB.todayISO());
        for (let i = 0; i < list.length; i++) {
          const file = list[i];
          UI.progress(true, Math.round(i / list.length * 100), '正在归档 ' + (i + 1) + '/' + list.length + '：' + file.name);
          try {
            const parsedDate = Parser.parseDateFromName(file.name);
            const parsed = await Parser.extractText(file);
            const tpl = newDocTemplate(file, parsedDate, parsed);
            tpl.folderId = useAuto ? (matchFolderByName(file.name) || null) : fixed;
            if (useAuto && tpl.folderId) autoN++;
            const id = await DB.addDocument(tpl);
            newIds.push(id);
            okN++;
          } catch (err) {
            failN++;
            console.warn('[归档失败]', file.name, err);
          }
        }
        UI.progress(false);
        UI.closeDrawer();
        if (newIds.length && window.OCRJob) {
          OCRJob.loadSettings().then(function (st) {
            if (st.enabled) OCRJob.enqueueMany(newIds);
          });
        }
        await window.App.refresh();
        const newly = Events.newlyDone(
          beforeEvents,
          Events.compute(state.docs, state.series, DB.todayISO())
        );
        if (newly.length) {
          UI.celebrate('「' + newly[0].seriesName + '」已完成', newly[0].label + ' · 新归档 ' + okN + ' 份');
        }
        const intoSame = !useAuto && fixed ? '，统一归入「' + folderPath(fixed) + '」' : '';
        UI.toast('已归档 ' + okN + ' 份' + (failN ? '，' + failN + ' 份失败' : '') +
          (useAuto ? '，' + autoN + ' 份按名称自动归入文件夹' : '') + intoSame, failN ? 'err' : 'ok');
      });
    });
  }

  /* 多选移动：把勾选的文件一次性移入同一个文件夹（fid 为 null 表示移回未归类） */
  async function movePickedTo(fid) {
    const ids = state.archive.picked.slice();
    for (let i = 0; i < ids.length; i++) {
      await DB.updateDocument(ids[i], { folderId: fid });
    }
    state.archive.multi = false;
    state.archive.picked = [];
    await loadAll();
    await render('archive');
    UI.toast('已把 ' + ids.length + ' 份文件移到「' + (fid ? folderPath(fid) : '未归类') + '」', 'ok');
  }

  /* 选文件夹抽屉：多选移动用，含「移回未归类」与层级缩进 */
  function openPickFolderDrawer(onPick) {
    const html =
      '<div class="form">' +
      '<div class="field"><label>移动到<span class="hint">勾选的文件会一起移过去</span></label>' +
      '<div class="mv-list" id="mvList">' +
      '<button class="mv-row" data-pick-to="" type="button">' + UI.icon('inbox') +
      '<span class="mv-name">未归类（移出文件夹）</span></button>' +
      orderedFolders().map(function (o) {
        const prefix = o.depth > 0 ? '　'.repeat(Math.min(o.depth, 3) - 1) + '└ ' : '';
        return '<button class="mv-row" data-pick-to="' + o.f.id + '" type="button">' + UI.icon('folder') +
          '<span class="mv-name">' + prefix + esc(folderPath(o.f.id)) + '</span></button>';
      }).join('') +
      '</div></div>' +
      '<div class="form-actions"><button class="btn" data-cancel type="button">取消</button></div>' +
      '</div>';

    UI.openDrawer('移动到文件夹', html, function (body) {
      body.addEventListener('click', async function (e) {
        if (e.target.closest('[data-cancel]')) { UI.closeDrawer(); return; }
        const row = e.target.closest('[data-pick-to]');
        if (!row) return;
        const to = row.getAttribute('data-pick-to');
        UI.closeDrawer();
        onPick(to === '' ? null : parseInt(to, 10));
      });
    });
  }

  /* 系列模板表单 */
  function seriesFormHtml(s) {
    const fields = (s.fields && s.fields.length ? s.fields : [{ label: '', type: 'text' }]).slice();
    function row(f, i) {
      return '<div class="input-row" data-field-row style="margin-bottom:10px">' +
        '<input class="input" data-f-label value="' + esc(f.label) + '" placeholder="字段名，如 班级" style="flex:2">' +
        '<select class="input" data-f-type style="flex:1">' +
        '<option value="text"' + (f.type === 'text' ? ' selected' : '') + '>文本</option>' +
        '<option value="number"' + (f.type === 'number' ? ' selected' : '') + '>数字</option>' +
        '<option value="date"' + (f.type === 'date' ? ' selected' : '') + '>日期</option>' +
        '</select>' +
        '<button class="icon-btn sm neu press" data-remove-row type="button" aria-label="删除字段" style="flex:0 0 auto">' + UI.icon('close') + '</button>' +
        '</div>';
    }
    return '<div class="form">' +
      '<div class="field"><label for="seriesName">系列名称</label>' +
      '<input class="input" id="seriesName" value="' + esc(s.name || '') + '" placeholder="如 月度总结、成绩表"></div>' +
      '<div class="field"><label>字段<span class="hint">统计表的列</span></label>' +
      '<div id="fieldRows">' + fields.map(row).join('') + '</div>' +
      '<button class="btn" data-add-row type="button" style="margin-top:2px">' + UI.icon('plus') + '添加字段</button>' +
      '</div>' +
      '<div class="field"><label for="seriesCycle">周期事件<span class="hint">按周期检查该系列是否已归档</span></label>' +
      '<select class="input" id="seriesCycle">' +
      '<option value=""' + (!s.cycle ? ' selected' : '') + '>不做周期检查</option>' +
      '<option value="week"' + (s.cycle === 'week' ? ' selected' : '') + '>每周一份</option>' +
      '<option value="month"' + (s.cycle === 'month' ? ' selected' : '') + '>每月一份</option>' +
      '</select></div>' +
      '<div id="cycleOpts" style="display:' + (s.cycle ? 'block' : 'none') + '">' +
      '<div class="field"><label for="seriesRemind">完成提醒</label>' +
      '<select class="input" id="seriesRemind">' +
      '<option value="0"' + (!(s.remindDays > 0) ? ' selected' : '') + '>不提醒</option>' +
      '<option value="1"' + (s.remindDays === 1 ? ' selected' : '') + '>截止前 1 天提醒</option>' +
      '<option value="3"' + (s.remindDays === 3 ? ' selected' : '') + '>截止前 3 天提醒</option>' +
      '</select></div>' +
      '<label class="check-row" for="seriesIncluded"><input type="checkbox" id="seriesIncluded"' + (s.included !== false ? ' checked' : '') + '>参与事件统计</label>' +
      '</div>' +
      '<div class="form-actions">' +
      (s.id ? '<button class="btn danger" data-del-series type="button">删除</button>' : '<button class="btn" data-cancel type="button">取消</button>') +
      '<button class="btn primary" data-save-series type="button">保存</button>' +
      '</div>' +
      (s.id ? '<button class="btn" data-cancel type="button">取消</button>' : '') +
      '</div>';
  }

  async function openSeriesForm(series) {
    const s = series || { name: '', fields: [] };
    UI.openDrawer(s.id ? '编辑系列模板' : '新建系列模板', seriesFormHtml(s), function (body) {
      const cycleSel = body.querySelector('#seriesCycle');
      if (cycleSel) {
        cycleSel.addEventListener('change', function () {
          const opts = body.querySelector('#cycleOpts');
          if (opts) opts.style.display = cycleSel.value ? 'block' : 'none';
        });
      }
      body.addEventListener('click', async function (e) {
        if (e.target.closest('[data-cancel]')) { UI.closeDrawer(); return; }

        if (e.target.closest('[data-add-row]')) {
          const rows = body.querySelector('#fieldRows');
          const div = document.createElement('div');
          div.className = 'input-row';
          div.setAttribute('data-field-row', '');
          div.style.marginBottom = '10px';
          div.innerHTML =
            '<input class="input" data-f-label placeholder="字段名，如 班级" style="flex:2">' +
            '<select class="input" data-f-type style="flex:1"><option value="text">文本</option><option value="number">数字</option><option value="date">日期</option></select>' +
            '<button class="icon-btn sm neu press" data-remove-row type="button" aria-label="删除字段" style="flex:0 0 auto">' + UI.icon('close') + '</button>';
          rows.appendChild(div);
          div.querySelector('[data-f-label]').focus();
          return;
        }

        if (e.target.closest('[data-remove-row]')) {
          const rowEl = e.target.closest('[data-field-row]');
          const rows = body.querySelectorAll('[data-field-row]');
          if (rows.length <= 1) { UI.toast('至少保留一个字段'); return; }
          rowEl.remove();
          return;
        }

        if (e.target.closest('[data-del-series]')) {
          const used = await DB.seriesUsage(s.id);
          const ok = await UI.confirm({
            title: '删除这个系列模板？',
            message: used ? '该系列下有 ' + used + ' 份文档，删除模板后这些文档会脱离系列，记录与文件本体保留。' : '模板删除后无法恢复。',
            okText: '删除',
            danger: true
          });
          if (!ok) return;
          await DB.deleteSeries(s.id);
          if (state.stats.seriesId === s.id) state.stats.seriesId = null;
          UI.closeDrawer();
          UI.toast('模板已删除', 'ok');
          await window.App.refresh();
          return;
        }

        if (e.target.closest('[data-save-series]')) {
          const nameEl = body.querySelector('#seriesName');
          const name = nameEl.value.trim();
          if (!name) { UI.toast('系列名称不能为空'); return; }
          /* 按字段名匹配复用旧 key：模板增删字段后，已有文档的字段值不会错位或丢失 */
          const oldByLabel = {};
          (s.fields || []).forEach(function (f) { if (f.key && f.label && !(f.label in oldByLabel)) oldByLabel[f.label] = f; });
          const usedKeys = {};
          const rows = UI.$$('[data-field-row]', body);
          const fields = [];
          for (let i = 0; i < rows.length; i++) {
            const label = rows[i].querySelector('[data-f-label]').value.trim();
            const type = rows[i].querySelector('[data-f-type]').value;
            if (!label) continue;
            const old = oldByLabel[label];
            const key = old && !usedKeys[old.key] ? old.key
              : ('f' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 4));
            usedKeys[key] = true;
            fields.push({ key: key, label: label, type: type });
          }
          if (!fields.length) { UI.toast('至少填写一个字段名'); return; }
          const cycleSel = body.querySelector('#seriesCycle');
          const cycle = cycleSel ? cycleSel.value : '';
          const patch = { name: name, fields: fields };
          if (cycle) {
            patch.cycle = cycle;
            patch.remindDays = parseInt((body.querySelector('#seriesRemind') || {}).value || '0', 10) || 0;
            const inc = body.querySelector('#seriesIncluded');
            patch.included = inc ? !!inc.checked : true;
          } else {
            patch.cycle = null;
            patch.remindDays = 0;
            patch.included = true;
          }
          if (s.id) await DB.updateSeries(s.id, patch);
          else await DB.addSeries(patch);
          UI.closeDrawer();
          UI.toast('模板已保存', 'ok');
          await window.App.refresh();
        }
      });
    });
  }

  /* ---------- 批量管理 ---------- */

  async function openBulkManage() {
    const docs = state.docs.slice().sort(function (a, b) { return DB.compareDocs(a, b, 'archiveDate'); });
    const rows = docs.map(function (d) {
      return '<label class="row-item neu press" style="display:flex;align-items:center;gap:12px;cursor:pointer">' +
        '<input type="checkbox" data-pick="' + d.id + '" style="width:18px;height:18px;accent-color:#6C8BF5;flex:0 0 auto">' +
        '<span class="meter" style="flex:1;min-width:0">' +
        '<span class="r-name" style="display:block">' + esc(d.name) + '</span>' +
        '<span class="r-dates" style="display:flex;gap:12px;font-size:11px;color:#8A93A8;margin-top:2px"><span>归档 ' + esc(d.archiveDate || '—') + '</span><span>' + UI.fmtSize(d.size) + '</span></span>' +
        '</span>' +
        '</label>';
    }).join('');

    UI.openDrawer('批量管理', '<div class="form">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#8A93A8"><input type="checkbox" id="pickAll" style="width:18px;height:18px;accent-color:#6C8BF5">全选</label>' +
      '<span class="inline-hint" id="pickCount">未选择</span>' +
      '</div>' +
      '<div class="rows" style="max-height:56vh;overflow:auto">' + (rows || emptyBlock('暂无文件', '归档后在这里批量整理')) + '</div>' +
      '<button class="btn danger solid block" data-bulk-delete type="button">删除选中文件</button>' +
      '</div>', function (body) {
      const all = body.querySelector('#pickAll');
      const countEl = body.querySelector('#pickCount');
      function updateCount() {
        const n = body.querySelectorAll('[data-pick]:checked').length;
        countEl.textContent = n ? '已选 ' + n + ' 份' : '未选择';
      }
      if (all) {
        all.addEventListener('change', function () {
          UI.$$('[data-pick]', body).forEach(function (cb) { cb.checked = all.checked; });
          updateCount();
        });
      }
      body.addEventListener('change', function (e) {
        if (e.target.matches('[data-pick]')) updateCount();
      });
      body.addEventListener('click', async function (e) {
        if (!e.target.closest('[data-bulk-delete]')) return;
        const ids = UI.$$('[data-pick]:checked', body).map(function (cb) { return parseInt(cb.getAttribute('data-pick'), 10); });
        if (!ids.length) { UI.toast('先勾选要删除的文件'); return; }
        const ok = await UI.confirm({
          title: '删除选中的 ' + ids.length + ' 份文件？',
          message: '文件本体与记录会一起删除，无法恢复。',
          okText: '删除',
          danger: true
        });
        if (!ok) return;
        await DB.deleteMany(ids);
        UI.closeDrawer();
        UI.toast('已删除 ' + ids.length + ' 份', 'ok');
        await window.App.refresh();
      });
    });
  }

  /* ---------- 备份交互 ---------- */

  async function doExport() {
    try {
      UI.progress(true, 1, '正在整理数据');
      const res = await Backup.exportBackup(function (p, t) { UI.progress(true, p, t); });
      UI.progress(false);
      UI.openDrawer('备份已完成', UI.resultHtml(true, '备份已导出', res.count + ' 份文件 · ' + UI.fmtSize(res.size) + '\n文件已下载：' + res.name), function (body) {
        body.innerHTML += '<div class="form" style="margin-top:-6px"><button class="btn primary block" data-close-drawer type="button">知道了</button></div>';
      });
    } catch (err) {
      UI.progress(false);
      UI.toast('导出失败：' + (err && err.message ? err.message : '未知错误'), 'err');
    }
  }

  /* ---------- 导入通道（手机端） ---------- */

  async function storageInfo() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const quota = est.quota || 0;
        const usage = est.usage || 0;
        return { quota: quota, usage: usage, free: Math.max(0, quota - usage) };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function triggerPicker(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    try { el.click(); } catch (e) { UI.toast('无法打开文件选择器，请用浏览器打开再试'); }
  }

  function openImportSheet() {
    const html = '<div class="form import-sheet">' +
      '<button class="import-opt neu press" data-import-file type="button">' +
      '<span class="icon-box doc">' + UI.icon('file') + '</span>' +
      '<span class="io-main"><span class="io-title">从手机选择文件</span><span class="io-desc">文档、表格、PDF、图片，可多选</span></span>' +
      '<span class="io-chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<button class="import-opt neu press" data-import-camera type="button">' +
      '<span class="icon-box other">' + UI.icon('camera') + '</span>' +
      '<span class="io-main"><span class="io-title">拍照归档</span><span class="io-desc">直接调用相机拍摄纸质材料</span></span>' +
      '<span class="io-chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<button class="import-opt neu press" data-import-backup type="button">' +
      '<span class="icon-box sheet">' + UI.icon('download') + '</span>' +
      '<span class="io-main"><span class="io-title">导入备份包</span><span class="io-desc">从电脑导出的 zip，含全部文件与记录</span></span>' +
      '<span class="io-chev">' + UI.icon('chev') + '</span>' +
      '</button>' +
      '<div class="notice info">' +
      '<strong>把电脑资料搬到手机：</strong>电脑端「设置 → 导出备份」生成 zip → 用微信「文件传输助手」发到手机 → ' +
      'iPhone 在微信里打开 zip，点右上角「…」选「存储到文件」；安卓在「文件管理 → 微信/Download」里找 → ' +
      '回到这里点「导入备份包」选择该 zip。' +
      '</div>' +
      '<div class="inline-hint" id="importStorage">正在读取本机存储空间…</div>' +
      '</div>';

    UI.openDrawer('导入文件', html, function (body) {
      body.addEventListener('click', function (e) {
        if (e.target.closest('[data-import-file]')) {
          UI.closeDrawer();
          triggerPicker('filePicker');
          return;
        }
        if (e.target.closest('[data-import-camera]')) {
          UI.closeDrawer();
          triggerPicker('cameraPicker');
          return;
        }
        if (e.target.closest('[data-import-backup]')) {
          UI.closeDrawer();
          triggerPicker('backupPicker');
        }
      });
      storageInfo().then(function (info) {
        const box = body.querySelector('#importStorage');
        if (!box) return;
        if (!info || !info.quota) {
          box.textContent = '本机存储空间：浏览器未提供，导入时若空间不足会提示';
          return;
        }
        const warn = info.free < 200 * 1024 * 1024;
        box.className = 'inline-hint' + (warn ? ' warn' : '');
        box.textContent = '已用 ' + UI.fmtSize(info.usage) + ' · 可用约 ' + UI.fmtSize(info.free) +
          (warn ? '（空间偏紧，建议先导入小批次或清理旧文件）' : '');
      });
    });
  }

  function doImport(file) {
    const sizeLabel = UI.fmtSize(file.size);
    UI.openDrawer('恢复备份', '<div class="form">' +
      '<div class="notice info">将从「' + esc(file.name) + '」（' + sizeLabel + '）导入记录与文件本体。<span id="importZipSummary">正在读取备份内容…</span>' +
      '选择合并时，同一条记录以备份为准；选择覆盖时，先清空当前全部数据。</div>' +
      '<div class="inline-hint warn" id="importSpaceWarn" hidden></div>' +
      '<button class="btn primary block" data-import-mode="merge" type="button">合并导入（推荐）</button>' +
      '<button class="btn danger block" data-import-mode="replace" type="button">覆盖导入（清空现有数据）</button>' +
      '<button class="btn block" data-cancel type="button">取消</button>' +
      '</div>', function (body) {
      /* 异步读取 zip 摘要与剩余空间，给手机端一个明确的预期 */
      (async function () {
        try {
          if (window.JSZip) {
            const zip = await JSZip.loadAsync(file);
            const mf = zip.file('manifest.json');
            if (mf) {
              const m = JSON.parse(await mf.async('string'));
              const sum = document.getElementById('importZipSummary');
              if (sum) sum.textContent = ' 内含 ' + (m.documentCount || 0) + ' 份文件记录、' + (m.fileCount || 0) + ' 个文件本体。';
            }
          }
        } catch (e) { /* 摘要失败不阻塞导入 */ }
        const info = await storageInfo();
        const warnBox = document.getElementById('importSpaceWarn');
        if (info && info.quota && file.size && info.free < file.size * 2.5) {
          if (warnBox) {
            warnBox.hidden = false;
            warnBox.textContent = '本机可用空间约 ' + UI.fmtSize(info.free) + '，可能不足以解压这份备份（约需 ' +
              UI.fmtSize(Math.round(file.size * 2.5)) + '）。建议清理旧文件或分批导入。';
          }
        }
      })();

      body.addEventListener('click', async function (e) {
        const cancel = e.target.closest('[data-cancel]');
        if (cancel) { UI.closeDrawer(); return; }
        const btn = e.target.closest('[data-import-mode]');
        if (!btn) return;
        const mode = btn.getAttribute('data-import-mode');
        if (mode === 'replace') {
          const ok = await UI.confirm({
            title: '确定覆盖导入？',
            message: '当前设备上的全部文件与记录会被清空，然后写入备份内容。',
            okText: '覆盖导入',
            danger: true
          });
          if (!ok) return;
        }
        try {
          UI.progress(true, 2, '正在读取备份');
          const payload = await Backup.readBackup(file, function (p, t) { UI.progress(true, p, t); });
          UI.progress(true, 88, '正在写入本机');
          const res = await Backup.applyBackup(payload, mode);
          UI.progress(false);
          UI.closeDrawer();
          await window.App.refresh();
          UI.openDrawer('恢复完成', UI.resultHtml(true, '数据已恢复', res.documents + ' 份文件 · ' + res.series + ' 个模板'), function (b) {
            b.innerHTML += '<div class="form" style="margin-top:-6px"><button class="btn primary block" data-close-drawer type="button">知道了</button></div>';
          });
        } catch (err) {
          UI.progress(false);
          UI.openDrawer('恢复失败', UI.resultHtml(false, '没有导入', (err && err.message) || '备份文件无法读取，原有数据保持不变'), function (b) {
            b.innerHTML += '<div class="form" style="margin-top:-6px"><button class="btn primary block" data-close-drawer type="button">返回</button></div>';
          });
        }
      });
    });
  }

  /* ---------- 渲染与绑定 ---------- */

  function positionChipBg(wrap) {
    if (!wrap) return;
    const bg = wrap.querySelector('.chip-bg');
    const on = wrap.querySelector('.chip.on');
    if (!bg || !on) { if (bg) bg.style.width = '0px'; return; }
    bg.style.left = on.offsetLeft + 'px';
    bg.style.width = on.offsetWidth + 'px';
  }

  function bindChips(section) {
    UI.$$('[data-chips]', section).forEach(positionChipBg);
    requestAnimationFrame(function () { UI.$$('[data-chips]', section).forEach(positionChipBg); });
  }

  async function render(tab) {
    state.tab = tab || state.tab;
    const section = document.getElementById('view-' + state.tab);
    if (!section) return;

    if (state.tab === 'home') section.innerHTML = await homeHtml(DB.todayISO());
    else if (state.tab === 'archive') section.innerHTML = archiveHtml();
    else if (state.tab === 'records') section.innerHTML = recordsHtml();
    else if (state.tab === 'stats') section.innerHTML = statsHtml();
    else if (state.tab === 'events') section.innerHTML = await eventsHtml();
    else if (state.tab === 'search') {
      await runSearch();
      section.innerHTML = searchHtml();
    } else if (state.tab === 'settings') section.innerHTML = await settingsHtml();

    bindChips(section);
    bind(section);
  }

  function bind(section) {
    const tab = state.tab;

    section.onclick = async function (e) {
      const navBtn = e.target.closest('[data-nav]');
      if (navBtn) {
        window.App.switchTab(navBtn.getAttribute('data-nav'), true);
        return;
      }

      /* 搜索结果 / 关键词关联表：点击直接打开文件并定位关键词 */
      const kwDocBtn = e.target.closest('[data-kw-doc]');
      if (kwDocBtn) {
        const id = parseInt(kwDocBtn.getAttribute('data-kw-doc'), 10);
        const word = kwDocBtn.getAttribute('data-kw') || '';
        const doc = await DB.getDocument(id);
        if (!doc) { UI.toast('这份文件已被删除'); return; }
        if (!doc.blob) { UI.toast('这份记录没有文件本体'); return; }
        Viewer.open(doc, { query: word });
        return;
      }

      if (e.target.closest('[data-kw-custom]')) {
        openKwCustom();
        return;
      }

      const kwSearchBtn = e.target.closest('[data-kw-search]');
      if (kwSearchBtn) {
        await setSearchQuery(kwSearchBtn.getAttribute('data-kw-search'));
        return;
      }

      const viewOpenBtn = e.target.closest('[data-view-open]');
      if (viewOpenBtn) {
        const id = parseInt(viewOpenBtn.getAttribute('data-view-open'), 10);
        const doc = await DB.getDocument(id);
        if (!doc) { UI.toast('这份文件已被删除'); return; }
        if (!doc.blob) { UI.toast('这份记录没有文件本体，无法查看'); return; }
        Viewer.open(doc, { query: state.search.q.trim() });
        return;
      }

      const navStats = e.target.closest('[data-nav-stats]');
      if (navStats) {
        state.stats.seriesId = parseInt(navStats.getAttribute('data-nav-stats'), 10);
        window.App.switchTab('stats', true);
        return;
      }

      const folderBtn = e.target.closest('[data-folder]');
      if (folderBtn) {
        state.archive.folder = folderBtn.getAttribute('data-folder');
        state.archive.visible = 60;
        await render('archive');
        return;
      }

      /* 返回上一级（Windows 式层级导航） */
      const folderBack = e.target.closest('[data-folder-back]');
      if (folderBack) {
        state.archive.folder = folderBack.getAttribute('data-folder-back');
        state.archive.visible = 60;
        await render('archive');
        return;
      }

      /* 自主归档：按文件名与文件夹名称的关联，把未归类文件自动放进对应文件夹 */
      if (e.target.closest('[data-auto-archive]')) {
        const cands = state.docs.filter(function (d) { return !d.folderId; });
        let ok = 0;
        for (let i = 0; i < cands.length; i++) {
          const fid = matchFolderByName(cands[i].name);
          if (fid) { await DB.updateDocument(cands[i].id, { folderId: fid }); ok++; }
        }
        await loadAll();
        await render('archive');
        UI.toast(ok
          ? '已自动归档 ' + ok + ' 份' + (cands.length - ok ? '，' + (cands.length - ok) + ' 份未匹配到文件夹' : '')
          : '没有文件能按名称匹配到文件夹', ok ? 'ok' : '');
        return;
      }

      /* 多选模式开关 */
      if (e.target.closest('[data-multi]')) {
        state.archive.multi = !state.archive.multi;
        state.archive.picked = [];
        await render('archive');
        return;
      }
      if (e.target.closest('[data-multi-exit]')) {
        state.archive.multi = false;
        state.archive.picked = [];
        await render('archive');
        return;
      }
      if (e.target.closest('[data-pick-all]')) {
        const cards = Array.prototype.map.call(
          document.querySelectorAll('#view-archive .doc-list .doc-card'),
          function (c) { return parseInt(c.getAttribute('data-open'), 10); }
        );
        const allIn = cards.length && cards.every(function (id) { return state.archive.picked.indexOf(id) >= 0; });
        state.archive.picked = allIn ? [] : cards;
        await render('archive');
        return;
      }
      if (e.target.closest('[data-multi-move]')) {
        if (!state.archive.picked.length) { UI.toast('先勾选要移动的文件'); return; }
        openPickFolderDrawer(function (fid) { movePickedTo(fid); });
        return;
      }

      if (e.target.closest('[data-folder-new]')) {
        openFolderEditor(null);
        return;
      }

      const folderSub = e.target.closest('[data-folder-sub]');
      if (folderSub) {
        openFolderEditor(null, parseInt(folderSub.getAttribute('data-folder-sub'), 10));
        return;
      }

      const folderMove = e.target.closest('[data-folder-move]');
      if (folderMove) {
        const mf = folderById(parseInt(folderMove.getAttribute('data-folder-move'), 10));
        if (mf) openFolderMover(mf);
        return;
      }

      const folderRename = e.target.closest('[data-folder-rename]');
      if (folderRename) {
        const f = folderById(parseInt(folderRename.getAttribute('data-folder-rename'), 10));
        if (f) openFolderEditor(f);
        return;
      }

      const folderDel = e.target.closest('[data-folder-del]');
      if (folderDel) {
        await removeFolder(parseInt(folderDel.getAttribute('data-folder-del'), 10));
        return;
      }

      const monthBtn = e.target.closest('[data-month]');
      if (monthBtn) {
        state.archive.month = monthBtn.getAttribute('data-month');
        state.archive.visible = 60;
        await render('archive');
        return;
      }

      if (e.target.closest('[data-sort]')) {
        state.archive.sort = state.archive.sort === 'fileDate' ? 'archive' : 'fileDate';
        state.archive.month = 'all';
        state.archive.visible = 60;
        await render('archive');
        UI.toast(state.archive.sort === 'fileDate' ? '已按文件名日期排序' : '已按归档时间排序');
        return;
      }

      if (e.target.closest('[data-more-archive]')) {
        state.archive.visible += 60;
        await render('archive');
        return;
      }

      const recFilter = e.target.closest('[data-record-filter]');
      if (recFilter) {
        state.records.filter = recFilter.getAttribute('data-record-filter');
        state.records.visible = 80;
        await render('records');
        return;
      }

      if (e.target.closest('[data-more-records]')) {
        state.records.visible += 80;
        await render('records');
        return;
      }

      /* 备忘录：快速添加 / 完成 / 删除 */
      if (e.target.closest('[data-import-open]')) { openImportSheet(); return; }
      if (e.target.closest('[data-sync-open]')) {
        if (window.SyncUI) window.SyncUI.open();
        else UI.toast('同步组件未加载');
        return;
      }
      if (e.target.closest('[data-memo-add]')) { await addMemoFromInput(section); return; }
      const memoToggle = e.target.closest('[data-memo-toggle]');
      if (memoToggle) {
        const id = parseInt(memoToggle.getAttribute('data-memo-toggle'), 10);
        const memo = await DB.db.memos.get(id);
        if (memo) {
          /* 勾选瞬间先播弹性动画，再更新数据刷新列表 */
          memoToggle.classList.add('pop');
          await new Promise(function (r) { setTimeout(r, 260); });
          await DB.updateMemo(id, { done: !memo.done });
          UI.toast(!memo.done ? '已完成，真棒' : '已恢复为待办', 'ok');
        }
        await render('home');
        return;
      }
      const memoDel = e.target.closest('[data-memo-del]');
      if (memoDel) {
        await DB.deleteMemo(parseInt(memoDel.getAttribute('data-memo-del'), 10));
        UI.toast('待办已删除');
        await render('home');
        return;
      }
      const memoPostpone = e.target.closest('[data-memo-postpone]');
      if (memoPostpone) {
        const id = parseInt(memoPostpone.getAttribute('data-memo-postpone'), 10);
        const memo = await DB.db.memos.get(id);
        if (memo) {
          const nd = nextDayISO(memo.date);
          await DB.updateMemo(id, { date: nd });
          UI.toast('已推迟到 ' + UI.fmtDate(nd), 'ok');
        }
        await render('home');
        return;
      }
      const memoEdit = e.target.closest('[data-memo-edit]');
      if (memoEdit) {
        state.memoEditId = parseInt(memoEdit.getAttribute('data-memo-edit'), 10);
        await render('home');
        const inp = document.getElementById('memoEditInput');
        if (inp) { inp.focus(); inp.select(); }
        return;
      }
      const memoSave = e.target.closest('[data-memo-save]');
      if (memoSave) {
        const id = parseInt(memoSave.getAttribute('data-memo-save'), 10);
        const inp = document.getElementById('memoEditInput');
        const dateInp = document.getElementById('memoEditDate');
        const timeInp = document.getElementById('memoEditTime');
        const placeInp = document.getElementById('memoEditPlace');
        const text = inp ? inp.value.trim() : '';
        if (!text) { UI.toast('内容不能为空'); if (inp) inp.focus(); return; }
        await DB.updateMemo(id, {
          text: text,
          date: dateInp && dateInp.value ? dateInp.value : DB.todayISO(),
          time: timeInp ? timeInp.value : '',
          place: placeInp ? placeInp.value.trim() : ''
        });
        state.memoEditId = null;
        UI.toast('已保存修改', 'ok');
        await render('home');
        return;
      }
      if (e.target.closest('[data-memo-cancel]')) {
        state.memoEditId = null;
        await render('home');
        return;
      }

      /* 周历：点某一天 → 只看当天的待办 */
      const calDay = e.target.closest('[data-cal-day]');
      if (calDay) {
        const iso = calDay.getAttribute('data-cal-day');
        state.home.day = state.home.day === iso ? '' : iso;
        await render('home');
        const anchor = document.getElementById('todoAnchor');
        if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (e.target.closest('[data-cal-clear]')) {
        state.home.day = '';
        await render('home');
        const anchor = document.getElementById('todoAnchor');
        if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      if (e.target.closest('[data-todo-done]')) {
        await openTodoDone();
        return;
      }

      const openBtn = e.target.closest('[data-open]');
      if (openBtn) {
        const id = parseInt(openBtn.getAttribute('data-open'), 10);
        /* 多选模式下点文件＝勾选/取消勾选，不打开详情 */
        if (state.archive.multi && state.tab === 'archive') {
          const ix = state.archive.picked.indexOf(id);
          if (ix >= 0) state.archive.picked.splice(ix, 1);
          else state.archive.picked.push(id);
          await render('archive');
          return;
        }
        const doc = await DB.getDocument(id);
        if (doc) openDocForm(doc, 'edit');
        return;
      }

      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) {
        const id = parseInt(editBtn.getAttribute('data-edit'), 10);
        const doc = await DB.getDocument(id);
        if (doc) openDocForm(doc, 'edit');
        return;
      }

      const sOpen = e.target.closest('[data-series-open]');
      if (sOpen) {
        state.stats.seriesId = parseInt(sOpen.getAttribute('data-series-open'), 10);
        await render('stats');
        return;
      }

      if (e.target.closest('[data-series-back]')) {
        state.stats.seriesId = null;
        await render('stats');
        return;
      }

      if (e.target.closest('[data-new-series]')) { openSeriesForm(null); return; }

      const evSeg = e.target.closest('[data-ev-seg]');
      if (evSeg) {
        state.events.seg = evSeg.getAttribute('data-ev-seg');
        await render('events');
        return;
      }

      const viewDocBtn = e.target.closest('[data-view-doc]');
      if (viewDocBtn) {
        const id = parseInt(viewDocBtn.getAttribute('data-view-doc'), 10);
        const doc = await DB.getDocument(id);
        if (!doc) { UI.toast('原文件已删除，无法查看'); return; }
        Viewer.open(doc);
        return;
      }

      if (e.target.closest('[data-more-viewlogs]')) {
        state.events.visible += 100;
        await render('events');
        return;
      }

      const evSeries = e.target.closest('[data-ev-series]');
      if (evSeries) {
        const v = evSeries.getAttribute('data-ev-series');
        state.events.seriesId = v ? parseInt(v, 10) : null;
        await render('events');
        return;
      }

      if (e.target.closest('[data-ev-new-series]')) { openSeriesForm(null); return; }

      const editSeries = e.target.closest('[data-edit-series]');
      if (editSeries) {
        const s = seriesById(parseInt(editSeries.getAttribute('data-edit-series'), 10));
        if (s) openSeriesForm(s);
        return;
      }

      if (e.target.closest('[data-export-csv]')) {
        const s = seriesById(state.stats.seriesId);
        if (!s) return;
        const docs = state.docs.filter(function (d) { return d.seriesId === s.id; })
          .sort(function (a, b) { return DB.compareDocs(a, b, 'fileDate'); });
        const fields = s.fields || [];
        /* CSV 列与统计表保持一致：文件名、文件日期、模板字段 */
        const headers = ['文件名', '文件日期'].concat(fields.map(function (f) { return f.label; }));
        const rows = docs.map(function (d) {
          return [d.name, d.fileDate || ''].concat(fields.map(function (f) {
            return d.fields && d.fields[f.key] != null ? d.fields[f.key] : '';
          }));
        });
        Backup.exportCsv(headers, rows, s.name + '-统计表.csv');
        UI.toast('已导出 CSV', 'ok');
        return;
      }

      /* v2.7.0 自定义筛选词：点词检索 / 打开管理抽屉 */
      const qfWord = e.target.closest('[data-q-filter-word]');
      if (qfWord) {
        const w = qfWord.getAttribute('data-q-filter-word') || '';
        state.search.q = w;
        const g = document.getElementById('globalSearch');
        if (g) { g.value = w; syncGlobalClear(); }
        await render('search');
        return;
      }
      if (e.target.closest('[data-q-filter-manage]')) { openSearchFilterWords(); return; }

      const qSeries = e.target.closest('[data-q-series]');
      if (qSeries) {
        const v = qSeries.getAttribute('data-q-series');
        state.search.seriesId = v ? parseInt(v, 10) : null;
        await render('search');
        return;
      }

      const qType = e.target.closest('[data-q-type]');
      if (qType) {
        state.search.ext = qType.getAttribute('data-q-type') || null;
        await render('search');
        return;
      }

      if (e.target.closest('[data-search-clear]')) {
        state.search.q = '';
        const g = document.getElementById('globalSearch');
        if (g) { g.value = ''; syncGlobalClear(); }
        await render('search');
        return;
      }

      if (e.target.closest('[data-bulk-manage]')) { openBulkManage(); return; }

      if (e.target.closest('[data-clear-all]')) {
        const ok = await UI.confirm({
          title: '清空全部数据？',
          message: '所有文件本体、记录、模板都会删除，无法恢复。建议先导出备份。',
          okText: '清空',
          danger: true
        });
        if (!ok) return;
        await DB.clearDocuments();
        state.stats.seriesId = null;
        UI.toast('已清空文件与记录', 'ok');
        await window.App.refresh();
        return;
      }

      if (e.target.closest('[data-export-backup]')) { doExport(); return; }

      if (window.OCRJob) {
        if (e.target.closest('[data-ocr-toggle]')) {
          const st = await OCRJob.setSettings({ enabled: !OCRJob.getSettings().enabled });
          UI.toast(st.enabled ? '已开启归档后自动识别' : '已关闭自动识别，仍可手动识别', 'ok');
          await render('settings');
          return;
        }
        if (e.target.closest('[data-ocr-lang]')) {
          const st = await OCRJob.setSettings({ cnOnly: !OCRJob.getSettings().cnOnly });
          UI.toast(st.cnOnly ? '已切换为仅中文' : '已切换为中文 + 英文', 'ok');
          await render('settings');
          return;
        }
        if (e.target.closest('[data-ocr-run]')) {
          if (!window.OCR || !OCR.isSupported()) { UI.toast('当前浏览器不支持本机文字识别', 'err'); return; }
          const n = await OCRJob.reindexAll();
          UI.toast(n ? '已排入 ' + n + ' 张，正在逐张识别，可继续用其他页面' : '没有可识别的图片', n ? 'ok' : '');
          await render('settings');
          return;
        }
        if (e.target.closest('[data-ocr-clear]')) {
          const ok = await UI.confirm({
            title: '清除全部识别文字？',
            message: '所有图片的识别文本都会删除，图片本身保留。清除后这些图片将不再被关键词检索到。',
            okText: '清除',
            danger: true
          });
          if (!ok) return;
          const n = await OCRJob.clearAll();
          UI.toast('已清除 ' + n + ' 份识别文字', 'ok');
          await render('settings');
          return;
        }
      }

      if (e.target.closest('[data-import-backup]')) {
        const picker = document.getElementById('backupPicker');
        picker.value = '';
        picker.click();
        return;
      }
    };

    if (tab === 'search') {
      /* 输入框在全局搜索栏（index.html），由 App 负责绑定；这里同步一次回显 */
      const g = document.getElementById('globalSearch');
      if (g) {
        g.value = state.search.q;
        syncGlobalClear();
      }
    }

    if (tab === 'home') {
      /* 备忘录输入框：回车快速加入待办 */
      const memoInput = section.querySelector('#memoInput');
      if (memoInput) {
        memoInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); addMemoFromInput(section); }
        });
      }
      /* 行内编辑：回车保存 / Esc 取消 */
      const editInput = section.querySelector('#memoEditInput');
      if (editInput) {
        editInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            const saveBtn = section.querySelector('[data-memo-save]');
            if (saveBtn) saveBtn.click();
          } else if (e.key === 'Escape') {
            state.memoEditId = null;
            render('home');
          }
        });
      }
    }
  }

  async function refresh() {
    await loadAll();
    await render(state.tab);
  }

  async function go(tab) {
    state.tab = tab;
    await loadAll();
    await render(tab);
  }

  window.Views = {
    state: state,
    refresh: refresh,
    go: go,
    setSearchQuery: setSearchQuery,
    syncGlobalClear: function () { syncGlobalClear(); },
    handleFiles: handleFiles,
    openSeriesForm: openSeriesForm,
    openDocForm: openDocForm,
    openImportSheet: openImportSheet,
    doExport: doExport,
    doImport: doImport
  };
})();
