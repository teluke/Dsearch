# 工作文件 · 底层架构说明（v2.2.1 存档）

> 本文件描述**已经落地的实现**，不是规划稿。任何与代码不一致之处，以代码为准。
>
> 存档信息见文末「版本快照」。

---

## 1. 总体架构

单页 H5 应用（PWA），**零构建、零框架、零外部请求**：

| 维度 | 选型 | 说明 |
| --- | --- | --- |
| 运行形态 | 纯静态站 + 零依赖 Node 静态服务 | `index.html` + 原生 ES5 风格脚本，直接浏览器打开即可 |
| 模块组织 | 每个 `js/*.js` 一个 IIFE，挂到 `window.X` 命名空间 | 无 import/export、无打包器，靠 `index.html` 中脚本顺序保证依赖 |
| 样式 | 单文件 `css/style.css`，CSS 变量 + 新拟态（neu）风格 | 主色 `--primary` / `--primary-2`，浅底 #F0F4FD |
| 数据 | 浏览器 IndexedDB（Dexie 3 版 schema） | 单库 `gongzuowenjian`，无后端、无账号 |
| 离线 | Service Worker 预缓存应用壳 | 缓存版本号 `gongzuowenjian-vNN`，改动后必须递增 |
| 依赖 | 全部 vendor 到本地 `vendor/` | 无 CDN、无第三方请求（已用测试断言校验） |
| 部署 | 托管静态服务（node），`server.js` 负责安全头与路径拦截 | 分享链接带 sharecode，首次访问种 cookie |

**分层**：`index.html`（骨架/抽屉/查看器 DOM）→ `js/app.js`（路由、Tab、全局事件、刷新节流）→ `js/views.js`（各页面 HTML 生成 + 页面级事件）→ `js/ui.js`（图标、Toast、抽屉、进度、格式化）→ `js/db.js`（唯一数据出入口）→ IndexedDB。

---

## 2. 目录与模块职责

```
工作文件/
├── index.html            # 应用骨架：appbar、全局搜索、导航抽屉、7 个视图容器、查看器、Toast、进度条
├── manifest.json         # PWA 清单（id=workfile-local-archive，standalone，图标 192/512）
├── sw.js                 # Service Worker：预缓存 ASSETS，缓存优先 + 导航回退
├── server.js             # 零依赖静态服务器（禁目录列表/隐藏文件/tests/路径穿越，SPA 回退）
├── package.json          # 仅声明 start 脚本
├── css/style.css         # 全部样式（1895 行），按「基础 → 组件 → 各页面 → 版本补丁」顺序追加
├── assets/               # 图标、书写体子集字体
├── js/
│   ├── db.js             # Dexie schema、CRUD、排序规则、容量校验、设置项
│   ├── parser.js         # 扩展名/类型、文件名日期与序号解析、正文提取（docx/xlsx/pdf/txt/csv）
│   ├── events.js         # 周期事件计算（是否到期、逾期、提醒、完成）
│   ├── keywords.js       # 中文关键词提取与「关键词 → 文档」关联表
│   ├── ocr.js            # OCR 引擎封装（预处理、语言、清洗、置信度）
│   ├── ocr-job.js        # OCR 任务队列、进度广播、断点续跑、统计与清理
│   ├── viewer.js         # 文件查看器：docx/xlsx/pdf/图片/文本渲染、关键词定位、表格冻结、OCR 面板
│   ├── backup.js         # 导出/导入 zip 备份（data.json + manifest.json + files/）
│   ├── sync.js           # WebRTC 局域网同步（配对、清单、分块传输、实时推送）
│   ├── sync-ui.js        # 同步面板与扫码界面（相机 / 二维码图片 / 粘贴返回码）
│   ├── views.js          # 7 个页面的 HTML 与交互（最大文件，2287 行）
│   ├── ui.js             # 图标库、Toast、Drawer、进度、日期体积格式化
│   └── app.js            # 启动、Hash 路由、Tab 切换、全局事件委托、刷新调度、PWA 注册
└── vendor/               # 本地依赖（见下表）
```

| 依赖 | 用途 | 许可 |
| --- | --- | --- |
| `dexie.min.js` | IndexedDB 封装 | Apache-2.0 |
| `jszip.min.js` | 备份打包/解包 | MIT/GPLv3 双许可 |
| `mammoth.browser.min.js` | docx → 纯文本 | BSD-2 |
| `xlsx.full.min.js` | xls/xlsx/csv → 文本 | Apache-2.0 |
| `pdf.min.js` + `pdf.worker.min.js` | PDF 渲染与取文本 | Apache-2.0 |
| `qrcode.min.js` | 生成配对二维码 | MIT |
| `jsqr.min.js` | 解码二维码图片/截图 | Apache-2.0 |
| `tesseract/` | OCR 引擎 + SIMD wasm + chi_sim/eng 语言包 | Apache-2.0（模型为 tessdata_fast） |

---

## 3. 启动与渲染链路

1. `index.html` 顺序加载 vendor → `js/db.js` → … → `js/app.js`。
2. `app.js` 启动：
   - `DB.initSettings()` 初始化默认设置；
   - `DB.allDocuments()` + `DB.listSeries()` + `DB.listMemos()` 载入内存 `state`；
   - `OCRJob.resumePending()` 续跑上次被打断的识别任务；
   - 依据 `location.hash` 切到对应 Tab，注册 SW、绑定全局事件。
3. Tab 切换：`switchTab(tab, updateHash)` → `Views.render(tab)` → 计算 HTML 字符串 → `innerHTML` 整体替换该视图 → 页面级事件由 `views.js` 的委托函数接管。
4. 数据变更后统一 `await App.refresh()`：重新拉全量数据 → 重渲染当前 Tab（节流 600ms；抽屉/弹窗/查看器打开或有输入焦点时跳过，避免打断操作）。

**事件委托**：全局点击/输入集中在 `app.js` 与 `views.js` 的若干 `addEventListener`，通过 `data-*` 属性判断目标（`data-open`、`data-memo-add`、`data-cal-day`、`data-nav` 等），不在生成的 HTML 中内联 `onclick`。

---

## 4. 数据层（IndexedDB / Dexie）

数据库名 `gongzuowenjian`，当前 schema **version(3)**：

```js
db.version(2).stores({
  documents: '++id, name, ext, seriesId, archiveDate, fileDate, createdAt, updatedAt',
  series:    '++id, name, createdAt',
  settings:  'key',
  viewLogs:  '++id, docId, viewedAt'
});
db.version(3).stores({           // v3 仅新增表，不改变既有表结构
  ...同上,
  memos: '++id, date, done, createdAt'
});
```

### documents 关键字段

| 字段 | 含义 |
| --- | --- |
| `id` | 自增主键 |
| `name` / `ext` / `mime` / `size` | 文件元信息 |
| `blob` | 文件本体（原格式，存 Blob） |
| `archiveDate` / `fileDate` / `dateSource` | 归档日期 / 文件名日期 / 日期来源（`name` 或 `manual`） |
| `seriesId` / `fields` | 所属系列 / 系列字段值对象 |
| `fullText` / `extractStatus` | 提取的正文 / `pending·done·failed·skipped` |
| `ocrText` / `ocrStatus` / `ocrAt` / `ocrConf` / `ocrChars` | 图片文字识别结果与状态（`none·pending·done·failed·empty`） |
| `seq` / `seqTag` | 文件名序号数值 / 展示标签（如「第3次」） |
| `fileModified` | 文件属性里的最后修改时间（同名排序用） |
| `createdAt` / `updatedAt` | 入库/更新时间戳（同步增量依据） |

### memos（待办）字段

`id, date(YYYY-MM-DD), time(HH:MM), place, text(标题), kind(事件类型), done, createdAt, updatedAt`

### 排序规则 `DB.compareDocs(a, b, sortKey)`

全站唯一口径（归档、记录、统计表、CSV、批量管理、搜索）：

1. 主日期（`archiveDate` 或 `fileDate`）新 → 旧；
2. 同一天且「同主体」（`Parser.nameKey()` 归一化后相同）：序号 `seq` 大 → 小；
3. 再按 `fileModified` 新 → 旧（**同名文件新版本排前面**）；
4. 最后按 `createdAt` 兜底。

### 容量与配额

`DB.storageInfo()` 取 `navigator.storage.estimate()`，写入前 `assertSpace()` 校验余量，不足抛 `QuotaError`，由界面转成中文提示。

---

## 5. 文本提取与检索

### 5.1 提取（`js/parser.js`）

| 类型 | 手段 | 状态 |
| --- | --- | --- |
| docx | mammoth `extractRawText` | done |
| xls / xlsx / csv | SheetJS `sheet_to_csv` | done |
| pdf | pdf.js `getTextContent()` 逐页拼接 | done |
| txt / md / json 等 | FileReader 文本 | done |
| 图片 | 交 OCR 子系统，写 `ocrText` | done |
| doc / wps / ppt 等 | 不解 | `skipped` |

同时解析**文件名日期**（多种中文/数字格式）与**序号**：先剔除文件名里的日期片段，再匹配 `第N次`、`第三次`、`(2)`、`-04`、末尾数字等，产出 `seq`/`seqTag`。

### 5.2 检索（`DB.searchDocuments(q)`）

关键词同时匹配 `name`、`fields` 值、`fullText`、`ocrText`；命中类型 `name / fields / text / ocr`，界面显示对应徽标（全文 / 字段 / 图片文字）并给出上下文摘要。

### 5.3 关键词关联表（`js/keywords.js`）

中文 2~4 字滑窗切词 → 统计文档频率 `df` → 过滤 `df < 2` → 去掉互为子串的词 → 每个词列出命中文档与上下文，渲染成表格放在主页待办区下方。`ocrText` 与 `fullText` 一同参与。

---

## 6. OCR 子系统

- **引擎**：tesseract.js 5.1.1 + core 5.1.0（只保留 `simd-lstm` 单文件 wasm 版）+ tessdata_fast 语言包（`chi_sim` 1.7MB / `eng` 2.0MB，gz 压缩）。
- **路径全本地**：`workerPath` / `corePath` / `langPath` 指向 `vendor/tesseract/...`，`cacheMethod: 'none'`（由 Service Worker 运行时缓存接管）。
- **预处理**（`js/ocr.js`）：等比缩放（长边上限 1600px）、灰度、对比度拉伸；识别后清洗：`[ \t]+` 去汉字间空格（**不能用 `\s+`，会吞掉换行**）、压缩 3 个以上换行。
- **队列**（`js/ocr-job.js`）：串行 `pump()`，一次只跑一个任务；每 900ms 节流刷新界面；`resumePending()` 在启动时补跑 `ocrStatus === 'pending'` 的记录（不动历史 `none`）。
- **存储**：结果写回 documents 的 `ocr*` 字段，随记录同存同删；设置页可一键清空识别文字。

---

## 7. 周期事件（`js/events.js`）

系列可开启周期（周/月），按「周期起点 + 归档情况」推算当前周期：

- 输出对象含 `seriesName`、`label`（如「第 12 周」）、`deadline`（**展示文本**，如「周截止 11月29日」）、`endISO`（**机器可比的 ISO 日期**）、`status`（`due / soon / overdue / done`）、`remind`、`docs`。
- ⚠️ 排序与筛选一律使用 `endISO`，不要用 `deadline`（后者是中文文本，字符串比较会错）。

---

## 8. 局域网同步（`js/sync.js` + `sync-ui.js`）

单向 **电脑 → 手机** 推送（避免双向冲突），纯 P2P，不经服务器。

| 阶段 | 机制 |
| --- | --- |
| 配对 | WebRTC DataChannel，`iceServers: []`（只走 host candidate，同 WiFi 直连）；SDP 用 `deflate-raw` 压缩 + base64（约 633 字符）以塞进二维码；双向可扫 |
| 传输 | 16KB 二进制分块（8 字节头：id + seq），40KB 清单分片，`bufferedAmount` 背压 |
| 增量 | 清单携带每条 `updatedAt + originId`，只传新增/更新 |
| 实时 | 电脑端 1.5s 快照轮询（`documents` / `memos` 的 id→updatedAt），有变化即推；备忘录增删改单独 `memo` / `memo-del` 消息 |
| 写入 | 手机端 `put` 到本地库，id 冲突保留双方数据（不覆盖已有的不同 id 记录） |

消息类型：`hello / pong / manifest / manifest-part / manifest-end / need / doc-begin / doc-meta-only / doc-end / del / memo / memo-del / done`。

**扫码入口**支持三种：相机（触屏设备默认）、选择二维码图片、粘贴截图（Ctrl+V）或粘贴返回码文本；整屏截图用 2x/3x 网格切片解码；二维码静区 4 个模块。

---

## 9. 备份与恢复（`js/backup.js`）

导出 zip 结构：

```
manifest.json         # 版本、时间、条数、系列数、总体积
data.json             # documents(不含 blob) + series + memos + settings
files/<id>.<ext>      # 文件本体
```

导入时先读 `manifest.json` 做版本与体积校验（`manifest.version > BACKUP_VERSION` 拒绝），再用 `storage.estimate` 判断空间，逐条写入，最后统一刷新。

---

## 10. PWA 与离线

- `manifest.json`：`id=workfile-local-archive`、`display=standalone`、`theme/background=#F0F4FD`、192/512 图标（含 maskable）。
- `sw.js`：`install` 预缓存 `ASSETS` 列表（含 CSS/全部 js/vendor/图标/字体）；`fetch` 缓存优先，导航请求失败回退 `./index.html`。
- **铁律**：任何一次改动 JS/CSS/SW 资源清单，都必须把 `CACHE` 版本号 +1，否则老用户拿到旧缓存。当前 `gongzuowenjian-v19`。
- ✅ 注意：`ASSETS` 里**不含** OCR 的 wasm 与语言包（运行到才加载），它们靠运行时缓存。

---

## 11. 部署与安全

- `server.js`：零依赖；拒绝 `.` 开头隐藏文件、`tests` 路径段、含 `..` 的路径；`normalize` 后做边界校验防穿越；**关闭目录列表**；SPA 回退到 `index.html`。
- 托管为 node 运行时，域名前缀 `workfile-archive`，链接带 `?sharecode=`，首次访问种 cookie。
- **数据安全口径**：无账号、无云端、无任何第三方请求（自动化测试断言页面所有请求同源）。测试样本目录（`tests-workfile/`）在部署目录之外。

---

## 12. 测试体系

用 `playwright-core` 驱动本机 Chrome，脚本在 `Dsearch/.workbuddy/pw/`：

| 脚本 | 覆盖 |
| --- | --- |
| `audit.js` | 核心 70 项（页面结构、归档、字段、统计、搜索、导航、安全提示） |
| `audit-events.js` / `audit-viewer.js` / `audit-searchview.js` | 事件 27 / 查看器 16 / 搜索视图 23 |
| `verify-stack.js` / `verify-pwa.js` | 查看器控制栈 6 / PWA 15 |
| `audit-v16.js` ~ `audit-v22.js` | 各版本新增功能（22/19/16/21/45/26/23 项） |
| `verify-v20-extra.js` | OCR 补充校验 7 项 |
| `verify-live.js` / `verify-live-ocr.js` | 线上复验（SW 版本、离线、资源可达、零外链） |

运行前先 `node server.js`（端口 5173）。WebRTC loopback 测试需 Chrome 参数：
`--allow-loopback-in-peer-connection --disable-features=WebRtcHideLocalIpsWithMdns`。

---

## 13. 已知边界与技术债

1. **单设备**：数据只在本机浏览器，换设备靠备份/同步手工迁移；浏览器清数据即丢失。
2. **存储上限**：受浏览器配额限制（约数百 MB 量级），不适合上千份大文件。
3. **手写/低质图片** OCR 准确率有限，只对印刷体友好。
4. `views.js`（2287 行）与 `style.css`（1895 行）已偏大，后续若继续加功能建议按页面拆分。
5. 无 TypeScript / 无构建，靠 `node --check` + 自动化测试兜底。
6. 局域网同步依赖同一 WiFi 且 AP 未开启客户端隔离；iOS Safari 的相机权限需 HTTPS。

---

## 版本快照

| 项 | 值 |
| --- | --- |
| 应用版本 | v2.2.1 |
| Git 标签 | `v2.2.1` |
| Service Worker 缓存 | `gongzuowenjian-v19` |
| IndexedDB schema | version 3 |
| 部署形态 | node 静态服务 · https://<private-host>.app.workbuddy.host |
| 应用体积 | 约 13MB（其中 `vendor/tesseract` 约 8MB） |
| 源码规模 | 约 8.7k 行（js + css + html + sw） |
