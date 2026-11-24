/* 关键词自动关联：从文档正文与文件名中提取高频关键词，
   整理成「关键词 → 相关文档 → 上下文摘录」表格。
   全部在本机计算，不产生任何网络请求；不写入数据库，
   每次数据变化时随视图刷新重新推导，与事件引擎同一思路。

   v2.3：支持「自定义关联」——用户在设置里钉住的关键词（settings.kwPinned）
   优先展示，即使只出现在 1 份文档里也照常列出。 */

(function () {
  /* 常见虚词/代词/量词作为停用词：出现在词首或词尾即丢弃 */
  const STOP_CHARS = '的了和与及或在是有对于上中下里把被个这那也很但就还而着不甘没为从向按据其所等之吗呢吧啊呀啦哟嘛么者each此类该另本各某异另'.split('');

  function isStopWord(w) {
    if (!w) return true;
    if (STOP_CHARS.indexOf(w[0]) >= 0) return true;
    if (STOP_CHARS.indexOf(w[w.length - 1]) >= 0) return true;
    return false;
  }

  /* 提取候选词：中文 2~4 字滑窗 + 4 位以上英文字母词 */
  function candidates(text, add) {
    const cjkSegs = String(text || '').match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (let s = 0; s < cjkSegs.length; s++) {
      const seg = cjkSegs[s];
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const w = seg.slice(i, i + n);
          if (!isStopWord(w)) add(w);
        }
      }
    }
    const eng = String(text || '').match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || [];
    for (let i = 0; i < eng.length; i++) add(eng[i]);
  }

  /* 上下文摘录：关键词首次出现位置前 16 字到后 24 字 */
  function contextOf(text, word) {
    const t = String(text || '');
    const idx = t.toLowerCase().indexOf(word.toLowerCase());
    if (idx < 0) return '';
    let start = Math.max(0, idx - 16);
    let end = Math.min(t.length, idx + word.length + 24);
    return (start > 0 ? '…' : '') + t.slice(start, end).replace(/\s+/g, ' ') + (end < t.length ? '…' : '');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 高亮摘录中的关键词（先转义再包 mark，避免注入） */
  function markCtx(ctx, word) {
    const safe = esc(ctx);
    if (!word) return safe;
    const parts = safe.split(new RegExp('(' + esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'));
    return parts.map(function (p) {
      return p.toLowerCase() === word.toLowerCase() ? '<mark class="kw-hit">' + p + '</mark>' : p;
    }).join('');
  }

  /* 参与关键词统计的正文：文档正文 + 图片识别出的文字 */
  function bodyOf(d) {
    return [(d.fullText || ''), (d.ocrText || '')].filter(function (t) { return t; }).join('\n');
  }

  /* 可检索语料：名称 + 正文 + 图片文字 */
  function corpus(docs) {
    return (docs || []).map(function (d) {
      const body = bodyOf(d);
      return { doc: d, body: body, hay: ((d.name || '') + '\n' + body).toLowerCase() };
    }).filter(function (r) {
      return r.hay.replace(/\s+/g, '').length >= 4;
    });
  }

  /* 某个词命中的文档与摘录；pinned 时允许只命中 1 份 */
  function rowOf(word, rows) {
    if (!word) return null;
    const low = word.toLowerCase();
    const hits = rows.filter(function (r) { return r.hay.indexOf(low) >= 0; });
    if (!hits.length) {
      return { word: word, count: 0, freq: 0, docs: [], ctx: '' };
    }
    const first = hits[0];
    return {
      word: word,
      count: hits.length,
      freq: hits.length,
      docs: hits.slice(0, 3).map(function (r) { return r.doc; }),
      ctx: first ? contextOf(first.body || first.doc.name, word) : ''
    };
  }

  /* 候选词清单（给「自定义关联」面板用）：[{word, count}]，按命中份数排 */
  function collect(docs, limit) {
    const rows = corpus(docs);
    if (!rows.length) return [];
    const freq = {};
    rows.forEach(function (r) {
      const seen = {};
      candidates(r.body, function (w) {
        if (seen[w]) return;
        seen[w] = 1;
        freq[w] = (freq[w] || 0) + 1;
      });
      candidates(r.doc.name || '', function (w) { freq[w] = (freq[w] || 0) + 1; });
    });
    const list = Object.keys(freq).map(function (w) { return { word: w, count: freq[w] }; })
      .filter(function (x) { return x.count >= 1 && x.word.length >= 2; });

    /* 滑窗会产生大量互为子串的候选（数学教研/学教研/教研）：
       若某个更长（或等长）的词出现份数不低于它且包含它，就丢弃短的 */
    const pruned = list.filter(function (x) {
      return !list.some(function (o) {
        if (o === x) return false;
        if (o.word.indexOf(x.word) < 0) return false;
        if (o.word.length < x.word.length) return false;
        return o.count >= x.count;
      });
    });

    /* 候选只列出现 ≥2 份的词，减少滑窗噪音；只出现 1 份的词可用「手动添加」 */
    return pruned.filter(function (x) { return x.count >= 2; })
      .sort(function (a, b) { return b.count - a.count || a.word.length - b.word.length; })
      .slice(0, limit || 60);
  }

  function rowHtml(r, pinned) {
    const docBadges = r.docs.map(function (d) {
      return '<button class="kw-doc neu press" data-kw-doc="' + d.id + '" data-kw="' + esc(r.word) + '" type="button">' + esc(d.name) + '</button>';
    }).join('');
    const pinBadge = pinned ? '<span class="kw-pin">自定义</span>' : '';
    return '<tr' + (pinned ? ' class="kw-row-pin"' : '') + '>' +
      '<td class="kw-word cell-strong"><button class="kw-btn" data-kw-search="' + esc(r.word) + '" type="button">' + esc(r.word) + '</button>' + pinBadge + '</td>' +
      '<td class="num kw-count">' + r.count + ' 份</td>' +
      '<td class="kw-docs">' + docBadges + '</td>' +
      '<td class="kw-ctx">' + markCtx(r.ctx, r.word) + '</td>' +
      '</tr>';
  }

  /* 主入口：返回 { list, pinned, html } */
  function build(docs, opts) {
    opts = opts || {};
    const limit = opts.limit || 8;
    const pinnedWords = (opts.pinned || []).map(function (w) { return String(w || '').trim(); })
      .filter(function (w) { return w.length >= 1; })
      .filter(function (w, i, arr) { return arr.indexOf(w) === i; })
      .slice(0, 12);

    const rows = corpus(docs);

    /* 自定义关联：即使只有 1 份也展示；一个都没命中时保留在「未命中」提示里 */
    const pinnedRows = pinnedWords.map(function (w) { return rowOf(w, rows); }).filter(Boolean);

    /* 自动关联：词频 → 命中份数 ≥2 → 去互相包含 */
    const withText = (docs || []).filter(function (d) { return bodyOf(d).length >= 8; });
    const autoRows = [];
    if (withText.length) {
      const freq = {};
      withText.forEach(function (d) {
        const seen = {};
        candidates(bodyOf(d), function (w) {
          if (seen[w]) return;
          seen[w] = 1;
          freq[w] = (freq[w] || 0) + 1;
        });
        candidates(d.name || '', function (w) { freq[w] = (freq[w] || 0) + 1; });
      });

      const pool = Object.keys(freq).filter(function (w) {
        return freq[w] >= (withText.length >= 5 ? 2 : 1);
      });

      const pinnedLower = pinnedWords.map(function (w) { return w.toLowerCase(); });
      const list = pool
        .filter(function (w) { return pinnedLower.indexOf(w.toLowerCase()) < 0; })
        .map(function (w) {
          const hits = rows.filter(function (r) { return r.hay.indexOf(w.toLowerCase()) >= 0; });
          const first = hits[0];
          return {
            word: w,
            count: hits.length,
            freq: freq[w],
            docs: hits.slice(0, 3).map(function (r) { return r.doc; }),
            ctx: first ? contextOf(first.body, w) : ''
          };
        })
        .filter(function (r) { return r.count >= 2; })
        .sort(function (a, b) {
          return b.count - a.count || b.freq - a.freq || a.word.length - b.word.length;
        })
        .slice(0, Math.max(0, limit - pinnedRows.filter(function (r) { return r.count > 0; }).length));

      /* 去掉互相包含的长词（保留更高频的短词） */
      autoRows.push.apply(autoRows, list.filter(function (r, i) {
        return !list.some(function (o, j) {
          return j < i && o.word.length < r.word.length && o.word.indexOf(r.word) < 0 && r.word.indexOf(o.word) >= 0;
        });
      }));
    }

    const shownPinned = pinnedRows.filter(function (r) { return r.count > 0; });
    const totalRows = shownPinned.length + autoRows.length;
    /* 没有文档时整块不占地方；有文档但还没提取到正文时，仍显示卡片以便自定义关联 */
    if (!pinnedWords.length && !totalRows && !(docs || []).length) return { list: [], pinned: [], html: '' };

    const rowsHtml = shownPinned.map(function (r) { return rowHtml(r, true); }).join('') +
      autoRows.map(function (r) { return rowHtml(r, false); }).join('');

    const body = totalRows
      ? '<div class="table-wrap"><table class="grid kw-table"><thead><tr>' +
        '<th>关键词</th><th>文档</th><th>相关文件</th><th>上下文摘录</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'
      : '<p class="kw-empty">还没有足够的正文可自动关联。点右上角「＋ 自定义关联」，挑几个想一直盯着的词。</p>';

    /* 已钉住但一份都没命中的词，提示一下，避免以为设置丢了 */
    const missed = pinnedRows.filter(function (r) { return r.count === 0; }).map(function (r) { return r.word; });
    const missHtml = missed.length
      ? '<p class="kw-miss">暂未命中的自定义词：' + missed.map(function (w) { return esc(w); }).join('、') + '</p>'
      : '';

    const html =
      '<div class="kw-card neu">' +
      '<div class="kw-head"><span class="kw-title">' + (opts.title || '内容关键词关联') + '</span>' +
      '<span class="kw-sub">' + (shownPinned.length ? '自定义 ' + shownPinned.length + ' 个 · ' : '') + '从文档正文自动关联</span>' +
      '<button class="kw-custom neu press" data-kw-custom type="button">＋ 自定义关联</button></div>' +
      body + missHtml +
      '</div>';

    return { list: autoRows, pinned: shownPinned, html: html };
  }

  window.Keywords = {
    build: build,
    collect: collect,
    contextOf: contextOf
  };
})();
