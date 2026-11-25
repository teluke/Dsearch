/*
 * 局域网同步界面：配对码（二维码）展示与读取、进度、实时状态
 * 电脑通常没有摄像头，因此读取环节同时支持：选二维码图片、粘贴截图、粘贴返回码文本。
 */

(function () {
  let role = 'desk';          // desk（电脑，发送方）| phone（手机，接收方）
  let phase = 'idle';         // idle | offer | answer | connected | select | syncing | done | error
  let offerSdp = '';
  let answerSdp = '';
  let message = '';
  let progressText = '';
  let percent = 0;
  let syncedCount = 0;
  let lastError = '';
  let bodyEl = null;
  let autoStarted = false;
  let pickRows = [];          // 电脑端：手机缺哪些（id / name / size）
  let picked = new Set();     // 电脑端：勾选中的 id
  let auditInfo = null;       // 对账结果

  /* ---------- 二维码 ---------- */

  function b64(buf) {
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pack(obj) {
    const json = JSON.stringify(obj);
    if (window.CompressionStream) {
      try {
        const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return 'z' + b64(buf);
      } catch (e) { /* 降级 */ }
    }
    return 'p' + btoa(unescape(encodeURIComponent(json)));
  }

  async function unpack(text) {
    /* 粘贴回来的东西经常夹带换行和空格，base64 里本来就没有空白，一律去掉 */
    const raw = String(text || '').replace(/\s+/g, '');
    const kind = raw.charAt(0);
    const data = raw.slice(1);
    if (kind === 'z') {
      const stream = new Blob([unb64(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const json = await new Response(stream).text();
      return JSON.parse(json);
    }
    if (kind === 'p') return JSON.parse(decodeURIComponent(escape(atob(data))));
    return JSON.parse(raw);
  }

  /* 二维码超过这个长度就基本扫不出来了，也不再画（画出来也只是浪费时间） */
  const QR_MAX = 900;

  function qrMarkup(text) {
    if (!window.qrcode) return '<div class="qr-fallback">二维码组件未加载</div>';
    if (!text) return '<div class="qr-fallback">正在生成…</div>';
    if (text.length > QR_MAX) {
      return '<div class="qr-fallback">返回码有 ' + text.length + ' 字符，二维码密到扫不出来，' +
        '也会被微信压坏。<br>请用下面的「复制返回码」发文字过去。</div>';
    }
    try {
      const qr = window.qrcode(0, 'L');
      qr.addData(text);
      qr.make();
      /* margin 4：二维码静区不足时，截图识别率会明显下降 */
      return '<div class="qr-box" data-qr>' + qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true }) + '</div>';
    } catch (e) {
      return '<div class="qr-fallback">返回码有 ' + text.length + ' 字符，超出二维码容量。<br>请用下面的「复制返回码」。</div>';
    }
  }

  /* 把当前二维码存成 PNG（手机端把返回码发给电脑时用） */
  function saveQrPng() {
    const box = bodyEl && bodyEl.querySelector('[data-qr] svg');
    if (!box) { UI.toast('还没有生成二维码', 'err'); return; }
    const vb = (box.getAttribute('viewBox') || '').split(/\s+/);
    const size = vb.length === 4 ? Math.round(parseFloat(vb[2])) : 320;
    const clone = box.cloneNode(true);
    clone.setAttribute('width', String(size));
    clone.setAttribute('height', String(size));
    const svgText = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = function () {
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = size * scale;
      canvas.height = size * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { UI.toast('图片生成失败', 'err'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '配对码-' + new Date().toISOString().slice(0, 10) + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        UI.toast('已保存二维码图片', 'ok');
      }, 'image/png');
    };
    img.onerror = function () { UI.toast('二维码图片生成失败', 'err'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  }

  async function copyCode(text, label) {
    if (!text) { UI.toast('还没有生成' + (label || '返回码'), 'err'); return; }
    try {
      await navigator.clipboard.writeText(text);
      UI.toast('已复制，粘贴到另一台设备即可', 'ok');
    } catch (e) {
      UI.toast('复制失败，请长按选择文本手动复制', 'err');
    }
  }

  /* ---------- 图片解码（本机完成，不联网） ---------- */

  function tryDecode(canvas) {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(data.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      return code && code.data ? code.data : '';
    } catch (e) {
      return '';
    }
  }

  /* 整屏截图里二维码只占一小块，整体扫不到时按网格切片再扫 */
  function sliceTry(base) {
    const grids = [2, 3];
    for (let g = 0; g < grids.length; g++) {
      const n = grids[g];
      const tw = Math.floor(base.width / n);
      const th = Math.floor(base.height / n);
      if (tw < 80 || th < 80) continue;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          c.getContext('2d').drawImage(base, x * tw, y * th, tw, th, 0, 0, tw, th);
          let hit = tryDecode(c);
          if (hit) return hit;
          if (Math.max(tw, th) < 700) {
            const k = 2;
            const up = document.createElement('canvas');
            up.width = tw * k;
            up.height = th * k;
            const uctx = up.getContext('2d');
            uctx.imageSmoothingEnabled = false;
            uctx.drawImage(c, 0, 0, up.width, up.height);
            hit = tryDecode(up);
            if (hit) return hit;
          }
        }
      }
    }
    return '';
  }

  async function decodeImage(blob) {
    if (!window.jsQR) throw new Error('扫码组件未加载');
    const bmp = await createImageBitmap(blob);
    const base = document.createElement('canvas');
    base.width = bmp.width;
    base.height = bmp.height;
    base.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();

    let text = tryDecode(base);
    if (text) return text;

    /* 图片偏小时先整体放大再试 */
    const longSide = Math.max(base.width, base.height);
    if (longSide < 1400) {
      const k = Math.min(3, Math.max(2, 1200 / longSide));
      const up = document.createElement('canvas');
      up.width = Math.round(base.width * k);
      up.height = Math.round(base.height * k);
      const uctx = up.getContext('2d');
      uctx.imageSmoothingEnabled = true;
      uctx.drawImage(base, 0, 0, up.width, up.height);
      text = tryDecode(up);
      if (text) return text;
    }

    return sliceTry(base);
  }

  /* ---------- 读取二维码（相机 / 图片 / 截图 / 文本） ---------- */

  function scanCode(onResult, opts) {
    opts = opts || {};
    if (!window.jsQR) { UI.toast('扫码组件未加载', 'err'); return; }

    const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && opts.camera !== false;
    const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const autoCamera = opts.autoCamera != null ? opts.autoCamera : (hasCamera && isTouch);

    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML =
      '<div class="scan-card">' +
      '<p class="scan-title hand">读取配对码</p>' +
      '<div class="scan-stage"' + (autoCamera ? '' : ' hidden') + '><video playsinline muted autoplay></video><span class="scan-frame"></span></div>' +
      '<p class="scan-hint" data-scan-hint>' +
      (hasCamera ? '手机点「打开相机」对准二维码；电脑没有摄像头时，选图片或粘贴截图' : '这台设备没有可用的相机，选择二维码图片或粘贴截图') +
      '</p>' +
      '<div class="scan-actions">' +
      (hasCamera ? '<button class="btn primary block" data-scan-camera type="button"' + (autoCamera ? ' hidden' : '') + '>打开相机扫描</button>' : '') +
      '<button class="btn' + (hasCamera ? '' : ' primary') + ' block" data-scan-file type="button">选择二维码图片</button>' +
      '<button class="btn block" data-scan-paste type="button">粘贴截图（Ctrl+V）</button>' +
      '<button class="btn block" data-scan-cancel type="button">取消</button>' +
      '</div>' +
      '<p class="scan-tip">图片只在本机解码，不会上传。</p>' +
      '</div>';
    document.body.appendChild(overlay);

    const video = overlay.querySelector('video');
    const stage = overlay.querySelector('.scan-stage');
    const hintEl = overlay.querySelector('[data-scan-hint]');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream = null;
    let stopped = false;
    let raf = 0;

    function setHint(t) { if (hintEl) hintEl.textContent = t; }

    function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 忽略 */ } });
      document.removeEventListener('paste', onPaste);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function accept(text) {
      if (stopped) return;
      stop();
      onResult(String(text || '').trim());
    }

    async function handleBlob(blob) {
      setHint('正在识别图片…');
      try {
        const text = await decodeImage(blob);
        if (!text) {
          setHint('图片里没有找到二维码，换一张更清晰的截图试试');
          return;
        }
        accept(text);
      } catch (e) {
        setHint('图片读取失败：' + ((e && e.message) || '格式不支持'));
      }
    }

    function onPaste(e) {
      if (stopped) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const items = cd.items || [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          const file = items[i].getAsFile();
          if (file) { e.preventDefault(); handleBlob(file); return; }
        }
      }
      const txt = (cd.getData && cd.getData('text')) || '';
      const clean = txt.trim();
      if (clean && /^[zp{]/.test(clean)) { e.preventDefault(); accept(clean); }
    }

    document.addEventListener('paste', onPaste);

    overlay.addEventListener('click', function (e) {
      if (e.target.closest('[data-scan-cancel]') || e.target === overlay) { stop(); return; }

      if (e.target.closest('[data-scan-file]')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = function () {
          const file = input.files && input.files[0];
          input.remove();
          if (file) handleBlob(file);
        };
        input.click();
        return;
      }

      if (e.target.closest('[data-scan-paste]')) {
        setHint('按 Ctrl+V（手机长按输入框）粘贴截图或返回码');
        return;
      }

      if (e.target.closest('[data-scan-camera]')) {
        if (stream) return;
        if (stage) stage.hidden = false;
        startCamera();
      }
    });

    function startCamera() {
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      }).then(function (s) {
        if (stopped) { s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 忽略 */ } }); return; }
        stream = s;
        video.srcObject = s;
        const p = video.play();
        if (p && p.catch) p.catch(function () { /* 忽略 */ });
        setHint('把二维码放进框内，识别后自动返回');
        tick();
      }).catch(function (err) {
        if (stage) stage.hidden = true;
        setHint('打不开相机（' + ((err && err.message) || '权限被拒绝') + '），可以直接选图片或粘贴截图');
      });
    }

    function tick() {
      if (stopped || !stream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          try {
            const img = ctx.getImageData(0, 0, w, h);
            const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (code && code.data) { accept(code.data); return; }
          } catch (e) { /* 继续下一帧 */ }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    if (autoCamera) startCamera();
  }

  /* ---------- 面板 ---------- */

  function statusBadge() {
    const map = {
      idle: ['未配对', 'muted'],
      offer: ['等待手机扫码', 'warn'],
      answer: ['等待电脑读取', 'warn'],
      connected: ['已连接', 'ok'],
      select: ['等待选择文件', 'warn'],
      syncing: ['同步中', 'ok'],
      done: ['同步完成', 'ok'],
      error: ['出现问题', 'err']
    };
    const v = map[phase] || map.idle;
    return '<span class="sync-badge ' + v[1] + '">' + v[0] + '</span>';
  }

  function codeLenHint(code) {
    if (!code) return '';
    const n = code.length;
    return '<p class="inline-hint">返回码 ' + n + ' 字符' +
      (n <= QR_MAX ? ' · 二维码可以正常扫描' : ' · 二维码太密扫不出来，请用文字') + '</p>';
  }

  function manualAnswerHtml() {
    return '<details class="sync-manual" open>' +
      '<summary>粘贴返回码（推荐）</summary>' +
      '<textarea class="input" data-answer-text rows="3" placeholder="把另一台设备上的返回码粘贴到这里（以 z 或 p 开头的一长串字符）"></textarea>' +
      '<button class="btn primary block" data-answer-use type="button">用这段返回码连接</button>' +
      '</details>';
  }

  function pickRowHtml(r) {
    return '<label class="pick-row">' +
      '<input type="checkbox" data-pick-id="' + r.id + '"' + (picked.has(r.id) ? ' checked' : '') + '>' +
      '<span class="pick-name">' + UI.esc(r.name) + '</span>' +
      '<span class="pick-size">' + UI.fmtSize(r.size || 0) + '</span>' +
      '</label>';
  }

  function pickPanelHtml() {
    const rows = pickRows || [];
    if (!rows.length) {
      return '<div class="notice info">手机端已经是最新的，没有需要发送的文件。</div>' +
        '<button class="btn primary block" data-sync-again type="button">重新核对一次</button>' +
        '<button class="btn block" data-sync-reset type="button">断开连接</button>';
    }
    return '<div class="notice info">手机端比这台电脑少 <b>' + rows.length + '</b> 份。' +
      '勾选要发送的文件，默认全选。</div>' +
      '<div class="pick-tools">' +
      '<button class="btn pick-tool" data-pick-all type="button">全选</button>' +
      '<button class="btn pick-tool" data-pick-none type="button">全不选</button>' +
      '<span class="pick-count" data-pick-count>已选 ' + picked.size + ' 份</span>' +
      '</div>' +
      '<div class="pick-list">' + rows.map(pickRowHtml).join('') + '</div>' +
      '<button class="btn primary block" data-send-picked type="button">发送选中的 ' + picked.size + ' 份</button>' +
      '<button class="btn block" data-sync-reset type="button">断开连接</button>';
  }

  /* 对账结果：正常情况下只说一句「都到齐了」，出问题时把文件名列出来 */
  function auditHtml() {
    if (!auditInfo) return '';
    if (auditInfo.timeout) {
      return '<div class="notice warn">没等到手机端的对账回执（可能切到后台或连接已断）。' +
        '建议点「再同步一次」；如果还是不行，可以改用「导出备份 → 手机导入」。</div>';
    }
    if (auditInfo.ok) {
      return '<div class="notice info">已对账：手机端确认收到 ' + (auditInfo.got || 0) + ' 份，与发送数一致。</div>';
    }
    const names = (auditInfo.names || []).slice(0, 8);
    return '<div class="notice warn">有 ' + (auditInfo.missing || []).length + ' 份没送达：' +
      UI.esc(names.join('、')) + ((auditInfo.names || []).length > 8 ? ' 等' : '') +
      '。可点「再同步一次」重试；文件较大时建议改用「导出备份 → 手机导入」，更稳。</div>';
  }

  /* 大批量/大文件的兜底通道：直连怕手机切后台，zip 中转更稳 */
  function bulkHintHtml() {
    return '<details class="sync-manual">' +
      '<summary>文件很多、或单个文件很大？换一条更稳的路</summary>' +
      '<p class="inline-hint">直连传输全靠手机保持前台，一旦切到后台就可能中断。' +
      '文件多或体积大时，用「设置 → 备份与恢复 → 导出备份」在电脑上生成一个 zip，' +
      '通过微信/数据线传到手机，再在手机端「恢复备份」里选「合并」导入即可。' +
      '导入按电脑端的版本为准，份数也能精确对上。</p>' +
      '</details>';
  }

  function panelHtml() {
    const st = window.Sync ? window.Sync.state() : { connected: false };
    let main = '';

    if (!window.Sync || !window.Sync.isSupported()) {
      main = '<div class="notice warn">当前浏览器不支持局域网直连（WebRTC），请用 Chrome、Edge 或 Safari 打开。</div>';
    } else if (phase === 'idle' || phase === 'error') {
      main =
        (lastError ? '<div class="notice warn">' + UI.esc(lastError) + '</div>' : '') +
        '<div class="sync-role">' +
        '<button class="btn primary block" data-sync-desk type="button">这台是电脑，生成配对码</button>' +
        '<p class="inline-hint" style="text-align:center">电脑生成二维码，手机扫码后开始传输</p>' +
        '<button class="btn block" data-sync-phone type="button">这台是手机，扫描电脑二维码</button>' +
        '<p class="inline-hint" style="text-align:center">手机端扫描电脑屏幕上的二维码</p>' +
        '</div>';
    } else if (phase === 'offer') {
      main =
        '<div class="notice info">让手机/平板扫下面的二维码（同一 WiFi 下）。扫完那台设备会给你一段<strong>返回码</strong>，' +
        '拿回来粘在下面就行。</div>' +
        qrMarkup(offerSdp ? offerSdp : '') +
        codeLenHint(offerSdp) +
        manualAnswerHtml() +
        '<button class="btn block" data-sync-scan-answer type="button">读取手机返回码（选图片）</button>' +
        '<button class="btn block" data-sync-reset type="button">重新生成</button>';
    } else if (phase === 'answer') {
      /* 返回码优先走文字：图片过一遍微信压缩，密一点的二维码就废了 */
      main =
        '<div class="notice info">把这段<strong>返回码</strong>发到电脑上，在电脑端的输入框里粘贴，连接就建立了。' +
        '文字不会被压缩，比发图片可靠。</div>' +
        '<button class="btn primary block" data-copy-code type="button">复制返回码</button>' +
        codeLenHint(answerSdp) +
        '<details class="sync-manual"' + (answerSdp && answerSdp.length <= QR_MAX ? '' : ' hidden') + '>' +
        '<summary>或者让电脑扫这张二维码</summary>' +
        qrMarkup(answerSdp ? answerSdp : '') +
        '<button class="btn block" data-save-qr type="button">保存二维码图片</button>' +
        '<p class="inline-hint">一定要用「文件」方式发送原图，微信的图片压缩会把二维码糊掉。</p>' +
        '</details>' +
        '<p class="inline-hint" style="text-align:center">电脑端如果停在「等待读取」，就是返回码没送到，' +
        '回去用「复制返回码」发文字。</p>' +
        '<button class="btn block" data-sync-reset type="button">取消</button>';
    } else if (phase === 'select') {
      main = pickPanelHtml();
    } else {
      const stats = st.stats || {};
      main =
        '<div class="sync-progress">' +
        '<div class="sp-head"><span>' + UI.esc(progressText || '已连接') + '</span><span class="sp-num">' + (percent > 0 ? percent + '%' : '') + '</span></div>' +
        '<div class="sp-bar"><i style="width:' + Math.max(2, percent) + '%"></i></div>' +
        '</div>' +
        '<div class="sync-meta">' +
        '<span>已同步 ' + syncedCount + ' 份</span>' +
        '<span>传输 ' + UI.fmtSize(stats.bytes || 0) + '</span>' +
        '</div>' +
        (phase === 'done' ? auditHtml() : '') +
        (phase === 'done'
          ? '<button class="btn primary block" data-sync-again type="button">再同步一次</button>'
          : '') +
        '<button class="btn block" data-sync-reset type="button">断开连接</button>';
    }

    const legacy = st.peerProto && st.proto && st.peerProto !== st.proto;
    return '<div class="sync-panel">' +
      '<div class="sync-head">' + statusBadge() +
      '<span class="sync-role-tag">' + (role === 'desk' ? '电脑端' : '手机端') +
      (window.APP_VERSION ? ' · v' + window.APP_VERSION : '') + '</span>' +
      '</div>' +
      main +
      (legacy
        ? '<div class="notice warn">对端页面还是旧版本（协议 ' + st.peerProto + '，本端 ' + st.proto + '），' +
          '已自动切到兼容模式。传输能用，但对账与勾选功能不生效——' +
          '把两端页面都刷新一次（手机端要把应用完全关掉再打开）就能用上新版。</div>'
        : '') +
      ((phase === 'select' || phase === 'done') ? bulkHintHtml() : '') +
      '<div class="notice info" style="margin-top:6px">' +
      '数据只在两台设备之间直连传输，不经过任何服务器，也不需要登录。' +
      '建议两端连接同一个 WiFi；手机切到后台时连接会断开，回到前台重新配对即可。' +
      '</div>' +
      '</div>';
  }

  function render() {
    if (!bodyEl) return;
    bodyEl.innerHTML = panelHtml();
    bind();
  }

  function setPhase(p, msg) {
    phase = p;
    if (msg != null) message = msg;
    render();
  }

  function paintProgress(p) {
    if (!p) return;
    if (p.total > 0) percent = Math.min(100, Math.round(p.current / p.total * 100));
    progressText = p.stage + (p.total > 0 ? '（' + p.current + '/' + p.total + '）' : '') + (p.name ? ' · ' + p.name : '');
    const bar = bodyEl && bodyEl.querySelector('.sp-bar i');
    const label = bodyEl && bodyEl.querySelector('.sp-head span');
    const num = bodyEl && bodyEl.querySelector('.sp-num');
    if (bar) bar.style.width = Math.max(2, percent) + '%';
    if (label) label.textContent = progressText;
    if (num) num.textContent = percent > 0 ? percent + '%' : '';
  }

  /* ---------- 事件绑定 ---------- */

  async function useAnswerText(text) {
    const clean = String(text || '').trim();
    if (!clean) { UI.toast('先把返回码粘贴进来'); return; }
    try {
      const msg = await unpack(clean);
      if (msg.t !== 'answer') throw new Error('这段内容不是手机返回码');
      await window.Sync.acceptAnswer(msg.sdp);
      setPhase('connected', '正在建立连接');
    } catch (e) {
      lastError = (e && e.message) || '返回码无效';
      setPhase('error');
    }
  }

  function bind() {
    if (!bodyEl) return;
    const b = bodyEl;

    const deskBtn = b.querySelector('[data-sync-desk]');
    if (deskBtn) deskBtn.onclick = startDesk;
    const phoneBtn = b.querySelector('[data-sync-phone]');
    if (phoneBtn) phoneBtn.onclick = startPhone;
    const resetBtn = b.querySelector('[data-sync-reset]');
    if (resetBtn) {
      resetBtn.onclick = function () {
        window.Sync.disconnect();
        autoStarted = false;
        offerSdp = '';
        answerSdp = '';
        lastError = '';
        percent = 0;
        progressText = '';
        pickRows = [];
        picked = new Set();
        auditInfo = null;
        setPhase('idle');
      };
    }

    const saveQr = b.querySelector('[data-save-qr]');
    if (saveQr) saveQr.onclick = saveQrPng;
    const copyBtn = b.querySelector('[data-copy-code]');
    if (copyBtn) copyBtn.onclick = function () { copyCode(answerSdp, '返回码'); };

    const scanAnswer = b.querySelector('[data-sync-scan-answer]');
    if (scanAnswer) {
      scanAnswer.onclick = function () {
        scanCode(async function (text) {
          try {
            const msg = await unpack(text);
            if (msg.t !== 'answer') throw new Error('这不是手机返回码');
            await window.Sync.acceptAnswer(msg.sdp);
            setPhase('connected', '正在建立连接');
          } catch (e) {
            lastError = (e && e.message) || '返回码无效';
            setPhase('error');
          }
        }, { autoCamera: false });
      };
    }

    const useBtn = b.querySelector('[data-answer-use]');
    if (useBtn) {
      useBtn.onclick = function () {
        const ta = b.querySelector('[data-answer-text]');
        useAnswerText(ta ? ta.value : '');
      };
    }

    const again = b.querySelector('[data-sync-again]');
    if (again) {
      again.onclick = async function () {
        try {
          percent = 0;
          syncedCount = 0;
          auditInfo = null;
          setPhase('syncing', '重新同步中');
          await window.Sync.startSync();
        } catch (e) {
          lastError = (e && e.message) || '同步失败';
          setPhase('error');
        }
      };
    }

    /* ---- 选择面板 ---- */
    const listEl = b.querySelector('.pick-list');
    if (listEl) {
      listEl.addEventListener('change', function (e) {
        const cb = e.target && e.target.closest ? e.target.closest('[data-pick-id]') : null;
        if (!cb) return;
        const id = Number(cb.getAttribute('data-pick-id'));
        if (cb.checked) picked.add(id);
        else picked.delete(id);
        paintPick();
      });
    }
    const allBtn = b.querySelector('[data-pick-all]');
    if (allBtn) {
      allBtn.onclick = function () {
        pickRows.forEach(function (r) { picked.add(r.id); });
        render();
      };
    }
    const noneBtn = b.querySelector('[data-pick-none]');
    if (noneBtn) {
      noneBtn.onclick = function () {
        picked.clear();
        render();
      };
    }
    const sendBtn = b.querySelector('[data-send-picked]');
    if (sendBtn) {
      sendBtn.onclick = async function () {
        const ids = Array.from(picked);
        if (!ids.length) { UI.toast('至少勾选一份再发送', 'err'); return; }
        auditInfo = null;
        percent = 0;
        syncedCount = 0;
        setPhase('syncing', '正在发送选中的文件');
        try {
          await window.Sync.sendSelected(ids);
        } catch (e) {
          lastError = (e && e.message) || '发送失败';
          setPhase('error');
        }
      };
    }
  }

  /* 只更新勾选计数，不整块重绘（避免列表跳动、丢焦点） */
  function paintPick() {
    if (!bodyEl) return;
    const cnt = bodyEl.querySelector('[data-pick-count]');
    if (cnt) cnt.textContent = '已选 ' + picked.size + ' 份';
    const btn = bodyEl.querySelector('[data-send-picked]');
    if (btn) {
      btn.textContent = '发送选中的 ' + picked.size + ' 份';
      btn.disabled = picked.size === 0;
    }
  }

  async function startDesk() {
    role = 'desk';
    lastError = '';
    try {
      phase = 'offer';
      render();
      const sdp = await window.Sync.createOffer();
      offerSdp = await pack({ t: 'offer', sdp: sdp });
      setPhase('offer', '把二维码给手机扫');
    } catch (e) {
      lastError = (e && e.message) || '生成配对码失败';
      setPhase('error');
    }
  }

  function startPhone() {
    role = 'phone';
    lastError = '';
    scanCode(async function (text) {
      try {
        const msg = await unpack(text);
        if (msg.t !== 'offer') throw new Error('这不是电脑配对码');
        setPhase('answer', '正在生成返回码');
        const sdp = await window.Sync.acceptOffer(msg.sdp);
        answerSdp = await pack({ t: 'answer', sdp: sdp });
        setPhase('answer', '请用电脑读取这个返回码');
      } catch (e) {
        lastError = (e && e.message) || '配对码无效';
        setPhase('error');
      }
    }, { autoCamera: true });
  }

  /* ---------- 打开面板 ---------- */

  function openPanel(opts) {
    opts = opts || {};
    const st = window.Sync ? window.Sync.state() : { connected: false };
    /* 已连接时重开面板直接显示连接态；select / done 这类「有未完成操作」的阶段要保留，
       否则关一下面板再打开，勾选列表就没了 */
    if (!st.connected) phase = 'idle';
    else if (phase === 'idle' || phase === 'offer' || phase === 'answer') {
      phase = st.busy ? 'syncing' : 'connected';
    }
    percent = st.connected ? percent : 0;
    progressText = st.connected ? (progressText || '已连接') : '';
    syncedCount = st.connected ? syncedCount : 0;
    lastError = '';
    role = st.role || 'desk';

    UI.openDrawer('局域网同步', panelHtml(), function (body) {
      bodyEl = body;
      bind();
      /* 从折叠菜单「扫码连接电脑」进来：手机端直接开始扫码 */
      if (opts.scan && window.Sync && window.Sync.isSupported() && !st.connected) {
        setTimeout(function () { startPhone(); }, 320);
      }
      if (window.Sync && !window.Sync.__bound) {
        window.Sync.__bound = true;

        window.Sync.on('state', function (s) {
          if (!s.connected) {
            /* 传输中掉线：别让界面停在一个永远不动的进度条上 */
            if (phase === 'syncing' || phase === 'select') {
              progressText = '连接已断开';
              lastError = '连接已断开，请重新配对';
              setPhase('error');
            }
            return;
          }
          if (phase === 'offer' || phase === 'answer' || phase === 'idle') {
            setPhase('connected', '已连接');
          }
          if (role === 'desk' && !autoStarted) {
            autoStarted = true;
            setTimeout(function () {
              /* 勾选面板可能已经先弹出来了，别再改回去 */
              if (phase !== 'connected' || !window.Sync.state().connected) return;
              setPhase('syncing', '正在同步');
              window.Sync.startSync().catch(function (e) {
                lastError = (e && e.message) || '同步失败';
                setPhase('error');
              });
            }, 400);
          }
        });

        window.Sync.on('progress', function (p) { paintProgress(p); });

        /* 对端是旧版本：面板上直接说明，别让人干等 */
        window.Sync.on('peer-old', function () { render(); });

        /* 电脑端：手机回报差额 → 弹出勾选面板 */
        window.Sync.on('plan', async function (p) {
          const need = (p && p.need) || [];
          let rows = [];
          try {
            const docs = await DB.allDocuments();
            const map = new Map();
            docs.forEach(function (d) { map.set(d.id, d); });
            rows = need.map(function (id) {
              const d = map.get(id);
              return { id: id, name: d ? (d.name || '未命名') : ('未命名 #' + id), size: d ? (d.size || 0) : 0 };
            });
          } catch (e) {
            rows = need.map(function (id) { return { id: id, name: '未命名 #' + id, size: 0 }; });
          }
          rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); });
          /* 差额为空时电脑端会自动收尾，这一轮可能已经结束了，别再插一脚 */
          if (!window.Sync.state().busy) return;
          pickRows = rows;
          picked = new Set(rows.map(function (r) { return r.id; }));
          auditInfo = null;
          percent = 0;
          syncedCount = 0;
          setPhase('select', '手机端缺 ' + rows.length + ' 份');
        });

        /* 电脑端：对账结果 */
        window.Sync.on('audit', function (a) {
          auditInfo = a || null;
          if (phase === 'done') render();
        });

        window.Sync.on('file-done', function (d) {
          syncedCount++;
          const meta = bodyEl && bodyEl.querySelector('.sync-meta');
          if (meta) meta.firstElementChild.textContent = '已同步 ' + syncedCount + ' 份';
        });

        /* 电脑改了待办：手机端列表与统计由 App 自动刷新，这里只更新进度文案 */
        window.Sync.on('memo-push', function (d) {
          if (phase === 'done' || phase === 'connected') {
            progressText = '已同步 ' + (d && d.count ? d.count : 0) + ' 项待办变更';
            render();
          }
        });

        window.Sync.on('done', function (d) {
          syncedCount = Math.max(syncedCount, d.docs || 0);
          percent = 100;
          progressText = '同步完成';
          setPhase('done', '同步完成');
          if (window.App && window.App.refresh) window.App.refresh();
          const bad = auditInfo && !auditInfo.ok && !auditInfo.timeout ? (auditInfo.missing || []).length : 0;
          if (bad) UI.toast('同步完成，但有 ' + bad + ' 份没送达，详情见面板', 'err');
          else if (auditInfo && auditInfo.timeout) UI.toast('同步结束，但没收到手机端回执', 'warn');
          else UI.toast('同步完成，共 ' + syncedCount + ' 份', 'ok');
        });

        window.Sync.on('live', function () {
          if (phase === 'done' || phase === 'connected') {
            progressText = '已推送最新变更';
            render();
          }
        });

        window.Sync.on('error', function (e) {
          lastError = (e && e.message) || '连接出错';
          setPhase('error');
        });
      }
    });
  }

  window.SyncUI = { open: openPanel, scan: scanCode };
})();
