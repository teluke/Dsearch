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
  /* 走中转站进来就是「打开网址自动同步」，不再停下来等勾选；
     要一份份挑的，走旧扫码通道 */
  let relayAuto = false;

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

    /* 局域网 http 不是安全上下文，浏览器直接不给 mediaDevices（实测 secure:false / media:undefined）。
       这不是设备没相机，所以文案要说清楚原因，别让人以为平板坏了 */
    const secure = !!window.isSecureContext;
    const hasCamera = secure && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && opts.camera !== false;
    const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const autoCamera = opts.autoCamera != null ? opts.autoCamera : (hasCamera && isTouch);

    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML =
      '<div class="scan-card">' +
      '<p class="scan-title hand">读取配对码</p>' +
      '<div class="scan-stage"' + (autoCamera ? '' : ' hidden') + '><video playsinline muted autoplay></video><span class="scan-frame"></span></div>' +
      '<p class="scan-hint" data-scan-hint>' +
      (hasCamera ? '手机点「打开相机」对准二维码；电脑没有摄像头时，选图片或粘贴截图'
        : (secure ? '这台设备没有可用的相机，选择二维码图片或粘贴截图'
          : '这个网址是局域网 http，浏览器不允许网页调用相机（设备本身没坏）。请用平板自带的相机扫电脑屏幕，或把电脑上的网址粘进来')) +
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
    const rel = relSt();
    /* done 表示配对已交接，徽标要跟着传输阶段走，不能再显示「已连接」 */
    if (rel.phase && rel.phase !== 'idle' && rel.phase !== 'done') {
      const rmap = {
        opening: ['正在连接', 'warn'],
        wait: ['等平板扫码', 'warn'],
        connecting: ['正在连接', 'warn'],
        done: ['已连接', 'ok'],
        error: ['出现问题', 'err']
      };
      const rv = rmap[rel.phase] || rmap.opening;
      return '<span class="sync-badge ' + rv[1] + '">' + rv[0] + '</span>';
    }
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

  /* ---------- 中转站（v2.11） ----------
     配对只给一个网址，平板打开即连；内容端到端加密，服务端只转密文。 */

  function relSt() {
    return (window.Relay && window.Relay.state()) || { phase: 'idle' };
  }

  function relayPanelHtml() {
    const r = relSt();
    if (r.phase === 'wait' || r.phase === 'opening') {
      return '<div class="notice info">让平板扫下面的二维码，或者把网址发给它。' +
        '配对信息会自动交换，不用来回粘文字。</div>' +
        qrMarkup(r.url || '') +
        '<div class="relay-code"><span class="rc-label">配对码</span><strong>' + UI.esc(r.code || '') + '</strong></div>' +
        '<p class="inline-hint">相机扫不出就手输网址：<b>' + UI.esc(r.url || '') + '</b></p>' +
        (window.Relay && window.Relay.base()
          ? '<p class="inline-hint">平板首次打开这个 https 网址会提示证书不受信任，点「高级 → 继续前往」' +
            '即可，之后不会再问。文件仍走 WebRTC 加密直连。</p>'
          : '') +
        '<button class="btn block" data-relay-copy type="button">复制网址</button>' +
        '<p class="inline-hint" style="text-align:center">网址只在这台电脑开着中转时有效，关掉即失效。</p>' +
        '<button class="btn block" data-sync-reset type="button">关闭中转</button>';
    }
    if (r.phase === 'connecting') {
      return '<div class="notice info">' + UI.esc(r.message || '正在建立直连…') + '</div>' +
        '<div class="sync-progress"><div class="sp-head"><span>交换配对信息</span><span class="sp-num"></span></div>' +
        '<div class="sp-bar"><i style="width:60%"></i></div></div>' +
        '<p class="inline-hint" style="text-align:center">连上之后自动开始同步，不需要再点任何东西。</p>' +
        '<button class="btn block" data-sync-reset type="button">取消</button>';
    }
    if (r.phase === 'error') {
      return '<div class="notice warn">' + UI.esc(r.lastError || '中转出错') + '</div>' +
        '<button class="btn primary block" data-relay-desk type="button">重新开启中转</button>';
    }
    return '';
  }

  /* 内网 http（不是 localhost）就是非安全上下文：没有相机、没有离线缓存、独立一份库 */
  function isLanHttp() {
    if (location.protocol !== 'http:') return false;
    const h = location.hostname;
    return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]');
  }

  function noCam() {
    return !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* 平板扫不了码时的第二条入口：电脑面板能「复制网址」，粘过来一样能连 */
  function relayPasteHtml() {
    return '<details class="sync-manual"' + (noCam() ? ' open' : '') + '>' +
      '<summary>扫不了码？把电脑上的网址粘进来</summary>' +
      '<p class="inline-hint">在电脑的同步面板点「复制网址」，发到平板（微信发给自己、或粘到输入法剪贴板），' +
      '再粘到下面。粘完自动连，不用相机、也不用扫码。</p>' +
      '<div class="lan-jump">' +
      '<input type="text" data-relay-paste-input placeholder="http://192.168.1.5:5173/index.html#relay=…" autocomplete="off">' +
      '<button class="btn primary" type="button" data-relay-paste-go>连接</button>' +
      '</div>' +
      '</details>';
  }

  function lanNoticeHtml() {
    if (!isLanHttp()) return '';
    return '<details class="sync-manual">' +
      '<summary>这个地址和线上版本有什么不一样</summary>' +
      '<p class="inline-hint">当前地址是 <b>' + UI.esc(location.host) + '</b>（局域网 http），浏览器对这类地址有三条限制：' +
      '① 网页里调不了相机，扫码要用平板自带的相机扫电脑屏幕；' +
      '② 没有离线缓存，电脑关掉就开不了；' +
      '③ 文件存在这个网址名下，和线上版本是两份互不相通的库——' +
      '换回线上地址看到的是线上那份，别以为文件丢了。</p>' +
      '</details>';
  }

  function relayEntryHtml() {
    const cam = !noCam();
    return '<div class="sync-role">' +
      '<button class="btn primary block" data-relay-desk type="button">这台是电脑，开启中转</button>' +
      '<p class="inline-hint" style="text-align:center">电脑上运行着本机服务时用这条：平板打开网址就自动连、自动同步</p>' +
      (cam
        ? '<button class="btn block" data-relay-phone type="button">这台是平板，扫码连接电脑</button>' +
          '<p class="inline-hint" style="text-align:center">扫电脑屏幕上的网址二维码</p>'
        : '<p class="inline-hint" style="text-align:center">这台设备现在调不了网页相机：' +
          '平板请用<b>自带的相机</b>扫电脑屏幕上的二维码，扫到网址点开就自动连；' +
          '或者把电脑上的网址粘进来。</p>') +
      '</div>' +
      relayPasteHtml() +
      '<details class="sync-manual">' +
      '<summary>这条通道安全吗</summary>' +
      '<p class="inline-hint">连接只在本机局域网内，公网地址一律被拒绝。' +
      '中转服务只转发两段配对信息，不接触文件内容、不写磁盘，闲置十分钟自动销毁；' +
      '文件走 WebRTC 数据通道，由 DTLS 端到端加密，与直接扫码传输的强度相同。' +
      '如果担心同网段有人做中间人，仍可用下面「生成配对码 → 扫码」的离线交换方式。</p>' +
      '</details>';
  }

  /* 线上 https 页面：填一次电脑的 https 地址，就能继续用这个网址自动配对。
     不用换 origin、不用换库。老 http 跳转保留在折叠里，给没有 https 服务的场合用。 */
  function lanJumpHtml() {
    if (location.protocol !== 'https:' || isLanHttp()) return '';
    const base = window.Relay && window.Relay.base ? window.Relay.base() : '';
    const avail = window.Relay ? window.Relay.available() : null;
    return '<details class="sync-manual"' + (base ? '' : ' open') + '>' +
      '<summary>继续用这个网址自动同步（推荐）</summary>' +
      '<p class="inline-hint">电脑运行 <code>启动服务-https.bat</code>，把打印出来的 https 地址填一次。' +
      '平板第一次打开这个 https 地址时，浏览器会提示证书不受信任，点「高级 → 继续前往」一次。' +
      '之后平板扫电脑屏幕上的二维码就自动连，文件仍存在当前这个网址下，不用换地址。</p>' +
      '<div class="lan-jump">' +
      '<input type="text" data-relay-base-input placeholder="https://192.168.1.5:5173" autocomplete="off" value="' + UI.esc(base) + '">' +
      '<button class="btn primary" type="button" data-relay-base-save>' + (base ? '重新检测' : '保存并检测') + '</button>' +
      '</div>' +
      (base
        ? '<p class="inline-hint">已填：<b>' + UI.esc(base) + '</b>' +
          (avail === false ? ' · 连不上服务，确认电脑已启动 https 服务，并允许本网站访问局域网' : '') +
          '</p>' +
          (avail === false ? '<button class="btn block" type="button" data-relay-lna>允许访问局域网并重试</button>' : '') +
          '<button class="btn block" type="button" data-relay-base-clear>清除这个地址</button>'
        : '') +
      '</details>' +
      '<details class="sync-manual">' +
      '<summary>老办法：跳到电脑的局域网 http 地址</summary>' +
      '<p class="inline-hint">那条路不用证书，但会换一份空库，得从电脑重新同步一次；' +
      '而且 http 地址下网页调不了相机、也没有离线缓存。</p>' +
      '<div class="lan-jump">' +
      '<input type="text" inputmode="decimal" data-lan-input placeholder="例如 192.168.1.5:5173" autocomplete="off">' +
      '<button class="btn primary" type="button" data-lan-go>打开</button>' +
      '</div>' +
      '</details>';
  }

  /* 只允许跳私网地址，避免被塞进一个奇怪的网址 */
  function parseLanAddr(text) {
    let t = String(text || '').trim().replace(/\s+/g, '');
    t = t.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!t) return '';
    if (t.indexOf(':') < 0) t += ':5173';
    const m = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3}):(\d{1,5})$/.exec(t);
    if (!m) return '';
    const ip = m[1];
    const ok = /^10\./.test(ip) || /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^127\./.test(ip);
    if (!ok) return '';
    const port = parseInt(m[2], 10);
    if (!(port > 0 && port < 65536)) return '';
    return ip + ':' + port;
  }

  function legacyEntryHtml() {
    /* 中转要本机服务在跑；没有服务、或在纯静态部署上打开时，
       下面这组按钮就是唯一能用的路，所以不折叠 */
    const relayOk = !!(window.Relay && window.Relay.supported() && window.Relay.available() !== false);
    return '<p class="inline-hint" style="text-align:center;margin:10px 0 6px">' +
      (relayOk ? '或者：扫码配对（不依赖本机服务）' : '扫码配对') + '</p>' +
      '<div class="sync-role">' +
      '<button class="btn block" data-sync-desk type="button">这台是电脑，生成配对码</button>' +
      '<button class="btn block" data-sync-phone type="button">这台是手机，扫描电脑二维码</button>' +
      '</div>';
  }

  function panelHtml() {
    const st = window.Sync ? window.Sync.state() : { connected: false };
    const rel = relSt();
    let main = '';

    /* 中转站只负责配对：连上（done）之后交回原流程，勾选与进度都复用 */
    if (rel.phase && rel.phase !== 'idle' && rel.phase !== 'done') {
      return '<div class="sync-panel">' +
        '<div class="sync-head">' + statusBadge() +
        '<span class="sync-role-tag">' + (rel.role === 'desk' ? '电脑端' : '平板端') +
        (window.APP_VERSION ? ' · v' + window.APP_VERSION : '') + '</span>' +
        '</div>' + relayPanelHtml() + '</div>';
    }

    if (!window.Sync || !window.Sync.isSupported()) {
      main = '<div class="notice warn">当前浏览器不支持局域网直连（WebRTC），请用 Chrome、Edge 或 Safari 打开。</div>';
    } else if (phase === 'idle' || phase === 'error') {
      main =
        (lastError ? '<div class="notice warn">' + UI.esc(lastError) + '</div>' : '') +
        (window.Relay && window.Relay.supported() && window.Relay.available() !== false ? relayEntryHtml() : '') +
        lanJumpHtml() +
        lanNoticeHtml() +
        legacyEntryHtml();
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
        (window.Relay && window.Relay.supported()
          ? '<p class="inline-hint" style="text-align:center">总是卡在这一步？取消后改用中转：' +
            '电脑上点「开启中转」，这里扫它的网址，连上就自动同步。</p>'
          : '') +
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
      '文件只在这两台设备之间直连，不经过任何服务器，也不需要登录。' +
      '建议两端连同一个 WiFi；手机切到后台时连接会断开，回到前台重新配对即可。' +
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

  /* ---------- 中转站入口 ---------- */

  async function startRelayDesk() {
    role = 'desk';
    relayAuto = true;
    lastError = '';
    try {
      await window.Relay.open();
      render();
    } catch (e) {
      lastError = (e && e.message) || '开启中转失败';
      setPhase('error');
    }
  }

  async function joinRelay(sid, code) {
    role = 'phone';
    relayAuto = true;
    lastError = '';
    try {
      await window.Relay.join(sid, code);
      render();
    } catch (e) {
      lastError = (e && e.message) || '连接中转失败';
      setPhase('error');
    }
  }

  function startRelayPhone() {
    scanCode(function (text) {
      const m = /relay=([0-9a-f]{6,32})\.(\d{6})/.exec(String(text || ''));
      if (!m) { UI.toast('这不是中转网址二维码', 'err'); return; }
      joinRelay(m[1], m[2]);
    }, { autoCamera: true });
  }

  function bind() {
    if (!bodyEl) return;
    const b = bodyEl;

    const lanGo = b.querySelector('[data-lan-go]');
    if (lanGo) {
      lanGo.onclick = function () {
        const inp = b.querySelector('[data-lan-input]');
        const addr = parseLanAddr(inp ? inp.value : '');
        if (!addr) { UI.toast('填电脑的局域网地址，例如 192.168.1.5:5173', 'err'); return; }
        location.href = 'http://' + addr + '/';
      };
    }

    const baseSave = b.querySelector('[data-relay-base-save]');
    if (baseSave) {
      baseSave.onclick = async function () {
        const inp = b.querySelector('[data-relay-base-input]');
        try {
          await window.Relay.setBase(inp ? inp.value : '');
          render();
          const ok = window.Relay.available() !== false;
          UI.toast(ok ? '已连上电脑服务，中转入口已出现' : '地址已保存，电脑上的 https 服务还没连通',
            ok ? 'ok' : 'warn');
        } catch (e) {
          UI.toast((e && e.message) || '地址格式不对', 'err');
        }
      };
    }
    const baseClear = b.querySelector('[data-relay-base-clear]');
    if (baseClear) {
      baseClear.onclick = function () {
        window.Relay.clearBase();
        render();
      };
    }
    const lnaBtn = b.querySelector('[data-relay-lna]');
    if (lnaBtn) {
      lnaBtn.onclick = async function () {
        try {
          await window.Relay.ensureAccess();
          render();
          const ok = window.Relay.available() !== false;
          UI.toast(ok ? '已允许，中转入口已出现' : '还是连不上，检查电脑上的 https 服务',
            ok ? 'ok' : 'warn');
        } catch (e) {
          UI.toast((e && e.message) || '访问被浏览器拦下', 'err');
        }
      };
    }

    const relDesk = b.querySelector('[data-relay-desk]');
    if (relDesk) relDesk.onclick = startRelayDesk;
    const relPhone = b.querySelector('[data-relay-phone]');
    if (relPhone) relPhone.onclick = startRelayPhone;

    /* 平板粘网址：同址直接连，异址跳过去（跳过去那边页面自己会 join） */
    const pasteGo = b.querySelector('[data-relay-paste-go]');
    if (pasteGo) {
      pasteGo.onclick = function () {
        const inp = b.querySelector('[data-relay-paste-input]');
        const raw = String((inp && inp.value) || '').replace(/\s+/g, '');
        if (!raw) { UI.toast('先粘贴电脑上「复制网址」得到的那个网址', 'err'); return; }
        const m = /relay=([0-9a-f]{6,32})\.(\d{6})/.exec(raw);
        if (!m) { UI.toast('这段里没有配对信息，要粘带 #relay=… 的完整网址', 'err'); return; }
        let sameHost = true;
        try {
          const u = new URL(raw, location.href);
          sameHost = u.host === location.host;
        } catch (e) { /* 只有 #relay=… 的片段，按本页处理 */ }
        if (!sameHost) { location.href = raw; return; }
        joinRelay(m[1], m[2]);
      };
    }
    const relCopy = b.querySelector('[data-relay-copy]');
    if (relCopy) relCopy.onclick = function () { copyCode(relSt().url, '网址'); };
    const deskBtn = b.querySelector('[data-sync-desk]');
    if (deskBtn) deskBtn.onclick = startDesk;
    const phoneBtn = b.querySelector('[data-sync-phone]');
    if (phoneBtn) phoneBtn.onclick = startPhone;
    const resetBtn = b.querySelector('[data-sync-reset]');
    if (resetBtn) {
      resetBtn.onclick = function () {
        if (window.Relay && window.Relay.state().phase !== 'idle') {
          window.Relay.disconnect().catch(function () { /* 忽略 */ });
        }
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
        relayAuto = false;
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
    const deep = window.Relay ? window.Relay.parseHash() : null;
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
    role = deep ? 'phone' : (st.role || 'desk');

    UI.openDrawer('局域网同步', panelHtml(), function (body) {
      bodyEl = body;
      bind();
      /* 从折叠菜单「扫码连接电脑」进来：手机端直接开始扫码 */
      if (opts.scan && window.Sync && window.Sync.isSupported() && !st.connected) {
        setTimeout(function () { startPhone(); }, 320);
      }
      /* 扫网址进来（地址里带 #relay=…）：自动连上，不用再点按钮 */
      if (deep && window.Relay && window.Relay.supported()) {
        setTimeout(function () { joinRelay(deep.sid, deep.code); }, 320);
      }
      if (window.Relay && !window.Relay.__bound) {
        window.Relay.__bound = true;
        window.Relay.on('state', function () {
          if (!bodyEl) return;
          render();
        });
        window.Relay.on('progress', function () {
          if (!bodyEl) return;
          render();
        });
        window.Relay.on('error', function (e) {
          if (e && e.message) UI.toast(e.message, 'err');
        });
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
          if (relayAuto && role === 'desk') {
            pickRows = rows;
            picked = new Set(rows.map(function (r) { return r.id; }));
            auditInfo = null;
            percent = 0;
            syncedCount = 0;
            setPhase('syncing', '自动发送 ' + rows.length + ' 份');
            window.Sync.sendSelected(rows.map(function (r) { return r.id; })).catch(function (e) {
              lastError = (e && e.message) || '发送失败';
              setPhase('error');
            });
            return;
          }
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
