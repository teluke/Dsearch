/*
 * 图片文字识别（OCR）
 * 全部在本机 WebAssembly 内完成：图片不出设备、不发请求、不落第三方服务。
 * 识别引擎与语言包都放在 vendor/tesseract 下，首次使用时按需加载，之后由 Service Worker 缓存离线可用。
 */

(function () {
  const BASE = new URL('vendor/tesseract/', document.baseURI).href;
  const MAX_SIDE = 2200;      // 长边上限：过大只会拖慢，识别率提升很有限
  const MIN_SIDE = 900;       // 短边下限：手机拍的整页公文，字太小识别不出来
  const LANGS_FULL = 'chi_sim+eng';
  const LANGS_CN = 'chi_sim';

  let workerPromise = null;
  let workerLangs = '';
  let chain = Promise.resolve();   // 串行锁：一个引擎实例同时只处理一张
  let stageCb = null;
  let current = null;              // { docId, name, startedAt } 正在处理的任务

  /* ---------- 能力判断 ---------- */

  function isSupported() {
    return !!(window.Tesseract && typeof WebAssembly === 'object');
  }

  /* ---------- 图片预处理 ---------- */

  function drawToCanvas(bmp, scale) {
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    /* 透明底（截图、抠图）直接识别会大面积漏字，先铺白底 */
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas;
  }

  async function prepare(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const long = Math.max(bmp.width, bmp.height);
      const short = Math.min(bmp.width, bmp.height);
      let scale = 1;
      if (long > MAX_SIDE) scale = MAX_SIDE / long;
      else if (short < MIN_SIDE) scale = Math.min(2.5, MIN_SIDE / short);
      const canvas = drawToCanvas(bmp, scale);
      if (bmp.close) bmp.close();
      return canvas;
    } catch (e) {
      return blob;   // 解不了码就交给引擎自己试
    }
  }

  /* ---------- 文本清洗 ---------- */

  /* 汉字之间被识别出的空格（"工 作 文 件"）要去掉，英文单词之间的空格必须保留。
     注意只吃空格与制表符：换行是行结构信息，不能被当成空格合并掉。 */
  function squeezeCjkSpaces(text) {
    let t = text;
    for (let i = 0; i < 6; i++) {
      const next = t.replace(/([\u3400-\u9fff\uff00-\uffef])[ \t]+([\u3400-\u9fff\uff00-\uffef])/g, '$1$2');
      if (next === t) break;
      t = next;
    }
    return t;
  }

  function clean(raw) {
    let t = String(raw || '')
      .replace(/\r/g, '')
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map(function (line) { return line.trim(); })
      .join('\n');

    t = squeezeCjkSpaces(t);

    /* 丢掉只由符号/单字噪点组成的行，保留正常文字行 */
    const lines = t.split('\n').filter(function (line) {
      const s = line.trim();
      if (!s) return true;
      if (s.length === 1 && !/[\u4e00-\u9fffa-zA-Z0-9]/.test(s)) return false;
      if (s.length <= 2 && !/[\u4e00-\u9fffa-zA-Z0-9]/.test(s)) return false;
      return true;
    });

    t = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  /* ---------- 引擎 ---------- */

  const STAGE_MAP = {
    'loading tesseract core': ['正在加载识别引擎', 0.05, 0.35],
    'initializing tesseract': ['正在启动识别引擎', 0.35, 0.42],
    'loading language traineddata': ['正在加载中英文模型', 0.42, 0.78],
    'initializing api': ['正在初始化模型', 0.78, 0.86],
    'recognizing text': ['正在识别文字', 0.86, 1]
  };

  function onLog(m) {
    if (!m || !stageCb) return;
    const rule = STAGE_MAP[m.status];
    if (!rule) return;
    const p = Math.max(0, Math.min(1, typeof m.progress === 'number' ? m.progress : 0));
    stageCb(rule[0], rule[1] + (rule[2] - rule[1]) * p);
  }

  function langsOf() {
    /* 只认中文可省掉一份英文模型（约 2MB），在设置里可切换 */
    return window.OCRSettings && window.OCRSettings.cnOnly ? LANGS_CN : LANGS_FULL;
  }

  async function ensureWorker() {
    if (!isSupported()) throw new Error('当前浏览器版本过低，无法在本机识别图片文字');
    const langs = langsOf();
    if (workerPromise && workerLangs === langs) return workerPromise;

    if (workerPromise) {
      /* 语言切换：丢弃旧实例，重建 */
      const old = workerPromise;
      workerPromise = null;
      old.then(function (w) { try { w.terminate(); } catch (e) { /* 忽略 */ } }).catch(function () { /* 忽略 */ });
    }

    workerLangs = langs;
    workerPromise = window.Tesseract.createWorker(langs, 1, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE + 'core',
      langPath: BASE + 'lang',
      workerBlobURL: false,
      cacheMethod: 'none',   // 交给 Service Worker 缓存，避免 IndexedDB 再存一份
      gzip: true,
      logger: onLog
    }).catch(function (err) {
      workerPromise = null;
      workerLangs = '';
      throw err;
    });

    return workerPromise;
  }

  /* ---------- 对外识别 ---------- */

  async function runOne(blob, opts) {
    opts = opts || {};
    current = { docId: opts.docId || null, name: opts.name || '', startedAt: Date.now() };
    stageCb = function (stage, p) {
      if (opts.onProgress) opts.onProgress(stage, p);
    };
    try {
      const w = await ensureWorker();
      const prepared = await prepare(blob);
      if (opts.onProgress) opts.onProgress('正在识别文字', 0.88);
      const res = await w.recognize(prepared);
      const data = (res && res.data) || {};
      const text = clean(data.text);
      return {
        text: text,
        chars: text.length,
        confidence: Math.round(data.confidence || 0),
        ms: Date.now() - current.startedAt
      };
    } finally {
      stageCb = null;
      current = null;
    }
  }

  /* 串行执行：多张图片排队识别，避免同时占满内存 */
  function recognize(blob, opts) {
    const task = function () { return runOne(blob, opts); };
    const p = chain.then(task, task);
    chain = p.then(function () { /* 占位，保持链条不断 */ }, function () { /* 失败也继续下一张 */ });
    return p;
  }

  function busy() { return !!current; }
  function busyName() { return current ? current.name : ''; }

  /* 主动释放内存：识别完一批后调用 */
  function release() {
    if (!workerPromise) return;
    const p = workerPromise;
    workerPromise = null;
    workerLangs = '';
    p.then(function (w) { try { w.terminate(); } catch (e) { /* 忽略 */ } }).catch(function () { /* 忽略 */ });
  }

  window.OCR = {
    isSupported: isSupported,
    recognize: recognize,
    release: release,
    busy: busy,
    busyName: busyName,
    clean: clean
  };
})();
