/* 事件推导引擎：根据系列周期配置与真实文档记录实时计算，不落库 */

(function () {
  function pad(n) { return String(n).padStart(2, '0'); }

  /* 单期事件的手动修改：键 = 系列ID@周期键，由 views.js 从 settings 读进来 */
  let overrides = {};

  function setOverrides(obj) {
    overrides = obj && typeof obj === 'object' ? obj : {};
  }

  function toISO(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseISO(s) {
    const p = String(s || '').split('-').map(Number);
    return new Date(p[0] || 1970, (p[1] || 1) - 1, p[2] || 1);
  }

  /* 一周的起点：周一 */
  function weekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - (x.getDay() + 6) % 7);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function daysBetween(aISO, bISO) {
    return Math.round((parseISO(bISO) - parseISO(aISO)) / 86400000);
  }

  function monthLabelOf(startISO) {
    const p = startISO.split('-');
    return p[0] + '年' + parseInt(p[1], 10) + '月';
  }

  function weekLabelOf(startISO, endISO) {
    const s = startISO.split('-');
    const e = endISO.split('-');
    return parseInt(s[1], 10) + '月' + parseInt(s[2], 10) + '日 - ' + parseInt(e[1], 10) + '月' + parseInt(e[2], 10) + '日';
  }

  function deadlineLabel(ev) {
    const e = ev.endISO.split('-');
    const d = parseInt(e[1], 10) + '月' + parseInt(e[2], 10) + '日';
    return ev.cycle === 'week' ? '周截止 ' + d : '月截止 ' + d;
  }

  /*
   * compute(docs, seriesList, todayISO) → 事件数组
   * 每个事件 = 某周期区间内是否归档了对应系列的文档。
   * 归属日期口径与排序一致：文件日期 || 归档日期。
   */
  function compute(docs, seriesList, todayStr) {
    const out = [];
    (seriesList || []).forEach(function (s) {
      if (!s.cycle || s.cycle === 'none' || s.included === false) return;
      const cycle = s.cycle === 'week' ? 'week' : 'month';

      const dated = (docs || [])
        .filter(function (d) { return d.seriesId === s.id; })
        .map(function (d) { return { doc: d, date: d.fileDate || d.archiveDate || '' }; })
        .filter(function (x) { return x.date && x.date.length >= 10; });

      /* 起点：系列最早文档日期、系列创建时间、今天三者取最早，再落到周期起点 */
      let originISO = todayStr;
      if (s.createdAt) originISO = [toISO(new Date(s.createdAt)), originISO].sort()[0];
      dated.forEach(function (x) { if (x.date < originISO) originISO = x.date; });

      const origin = parseISO(originISO);
      const start = cycle === 'week' ? weekStart(origin)
        : new Date(origin.getFullYear(), origin.getMonth(), 1);
      const today = parseISO(todayStr);
      const curStart = cycle === 'week' ? weekStart(today)
        : new Date(today.getFullYear(), today.getMonth(), 1);

      let cursor = new Date(start.getTime());
      let guard = 0;
      while (cursor <= curStart && guard < 400) {
        let endD, key, baseStartISO, baseEndISO, baseLabel;
        if (cycle === 'week') {
          endD = addDays(cursor, 6);
          baseStartISO = toISO(cursor);
          baseEndISO = toISO(endD);
          key = 'w:' + baseStartISO;
          baseLabel = weekLabelOf(baseStartISO, baseEndISO);
          cursor = addDays(cursor, 7);
        } else {
          endD = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
          baseStartISO = toISO(cursor);
          baseEndISO = toISO(endD);
          key = 'm:' + baseStartISO.slice(0, 7);
          baseLabel = monthLabelOf(baseStartISO);
          cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        }
        guard++;

        /* 这一期被手动改过：标题、日期区间、提醒天数、说明以修改为准 */
        const overrideId = s.id + '@' + key;
        const o = overrides[overrideId] || {};
        const startISO = o.startISO || baseStartISO;
        const endISO = o.endISO || baseEndISO;
        const label = o.label || (startISO === baseStartISO && endISO === baseEndISO
          ? baseLabel : (cycle === 'week' ? weekLabelOf(startISO, endISO) : monthLabelOf(startISO)));
        const remindDays = (typeof o.remindDays === 'number') ? o.remindDays : (s.remindDays || 0);

        const inRange = dated
          .filter(function (x) { return x.date >= startISO && x.date <= endISO; })
          .sort(function (a, b) { return a.date < b.date ? 1 : -1; });

        let status;
        if (inRange.length) status = 'done';
        else if (endISO < todayStr) status = 'overdue';
        else status = 'pending';

        const dueIn = status === 'pending' ? daysBetween(todayStr, endISO) : null;
        const remind = status === 'pending' && remindDays > 0 && dueIn <= remindDays;

        out.push({
          seriesId: s.id,
          seriesName: o.title || s.name,
          cycle: cycle,
          key: key,
          overrideId: overrideId,
          custom: !!(o.title || o.hint || o.startISO || o.endISO || typeof o.remindDays === 'number'),
          startISO: startISO,
          endISO: endISO,
          label: label,
          hint: o.hint || '',
          deadline: deadlineLabel({ cycle: cycle, endISO: endISO }),
          status: status,
          dueIn: dueIn,
          remind: remind,
          remindDays: remindDays,
          docs: inRange.map(function (x) { return x.doc; }),
          topDoc: inRange.length ? inRange[0].doc : null
        });
      }
    });

    /* 待完成/逾期按截止早→晚，已完成按周期新→旧 */
    const pending = out.filter(function (e) { return e.status !== 'done'; })
      .sort(function (a, b) { return a.endISO < b.endISO ? -1 : 1; });
    const done = out.filter(function (e) { return e.status === 'done'; })
      .sort(function (a, b) { return a.endISO > b.endISO ? -1 : 1; });
    return pending.concat(done);
  }

  /* 已完成事件的键集合，用于检测“这次保存补齐了哪个事件” */
  function doneKeySet(events) {
    const set = {};
    (events || []).forEach(function (e) {
      if (e.status === 'done') set[e.seriesId + '@' + e.key] = true;
    });
    return set;
  }

  function newlyDone(before, after) {
    const b = doneKeySet(before);
    return (after || []).filter(function (e) {
      return e.status === 'done' && !b[e.seriesId + '@' + e.key];
    });
  }

  window.Events = {
    compute: compute,
    setOverrides: setOverrides,
    doneKeySet: doneKeySet,
    newlyDone: newlyDone
  };
})();
