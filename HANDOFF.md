# 工作文件 · 项目交接文档（HANDOFF）

> 用途：删掉对话后，从这个文件就能接上进度，不用重新问一遍。
> 最后更新：2026-11-27 12:50 ｜ 当前版本：**v2.29.0** ｜ 缓存：`gongzuowenjian-v74`

---

## 0. 30 秒上手

```bash
cd ~/Desktop/Dsearch/工作文件
node server.js                      # 静态服务，端口 5173
# 浏览器开 http://127.0.0.1:5173/index.html
```

改完 → 跑对应版本的 `audit-*.js` → 提交打 tag → 推 GitHub Pages。

线上：`https://teluke.github.io/Dsearch/`（私有实例，口令单独保管）

---

## 1. 项目是什么

纯前端 PWA，个人工作文件管理 + 课表提取。没有后端，数据全在浏览器 IndexedDB（Dexie，schema v5）。

- 技术栈：原生 JS（无框架）+ Dexie + Service Worker 版本缓存 + GitHub Pages
- 入口：`工作文件/index.html`，逻辑分在 `js/` 下 13 个模块
- 主要功能：文件归档（拖拽/分类/系列）、课表 CSV 提取与关键词筛选、事件提醒、文档统计、OCR、局域网同步（PROTO 2）

---

## 2. 目录地图

| 路径 | 说明 |
| --- | --- |
| `工作文件/` | 应用本体（部署这个目录的内容） |
| `工作文件/index.html` | 单页骨架，含 `.nav-drawer` 导航结构 |
| `工作文件/js/app.js` | 启动、导航、天空、触感、`window.App` 接口（561 行） |
| `工作文件/js/views.js` | 所有页面渲染，最大的一块（5185 行） |
| `工作文件/js/weather.js` | 天气取数 → 写 `html[data-weather]`（161 行） |
| `工作文件/css/style.css` | 主样式 + 末尾 v2.26 水晶按键段（3717 行） |
| `工作文件/css/sky.css` | 天空系统，**脚本生成的，别手改**（220 行 / 60KB） |
| `工作文件/sw.js` | SW 缓存版本 `gongzuowenjian-vNN` |
| `.workbuddy/tmp/make-sky2.py` | 生成 sky.css 的脚本（421 行） |
| `.workbuddy/pw/audit-*.js` | Playwright 审计脚本 |
| `.workbuddy/shots/vNNN/` | 各版本验收截图 |
| `.workbuddy/memory/*.md` | 按天的工作日志 |
| `VERSION.md` | 版本索引 + 每版变更明细 |
| `docs/` | PRD / ARCHITECTURE / RESTORE（v2.2.1 基线） |

---

## 3. 当前状态

- 版本 `APP_VERSION = '2.29.0'`（`js/app.js` 第 4 行），页脚 `工作文件 v2.29.0`
- SW 缓存 `gongzuowenjian-v74`，清单已含 `./css/sky.css`、`./js/weather.js`
- Git：commit `04448ac`，tag `v2.29.0`，已推 `origin/main`，Pages 已生效
- 工作区干净，无未提交改动

---

## 4. 天空系统（v2.27 起的重心，改背景先看这节）

### 4.1 DOM 结构（`index.html` 第 18–35 行）

```html
<div class="sky" id="sky" aria-hidden="true">
  <div class="sky-shadows">    <!-- v2.29 云影，3 层 -->
    <div class="sky-cloud c3"></div><div class="sky-cloud c2"></div><div class="sky-cloud c1"></div>
  </div>
  <div class="sky-clouds">     <!-- 云，3 层 -->
    <div class="sky-cloud c3"></div><div class="sky-cloud c2"></div><div class="sky-cloud c1"></div>
  </div>
  <div class="sky-precip"><i></i><i></i><i></i></div>  <!-- 雨丝 / 雪花，3 层 -->
  <div class="sky-light" id="skyLight"></div>          <!-- 光照层 -->
</div>
```

`.sky` 是 `position:fixed; inset:0; z-index:-1; pointer-events:none`。所有天空样式都在 `sky.css`。

### 4.2 四态切换

- 状态写在 `html[data-weather="sunny|cloudy|rain|snow"]`，由 `js/weather.js` 写入
- 取数：**wttr.in**（`https://wttr.in/?format=j1`，IP 定位，按 WWO 天气码分类）与 **open-meteo**（geojs 定位）**双源竞速**，谁先回用谁
- 按天缓存 `weatherDay` / `weatherKind`；失败写 `weatherTryAt`，六小时退避
- 只改背景形态，**界面上不显示任何天气数值**
- 设置里有开关 `weatherBg`（默认 true），`App.setWeatherBg(on)` 控制

### 4.3 云层怎么动

三层 `.sky-cloud`，`width: calc(100% + var(--tile-w))`，`background-size: var(--tile-w) 100%` 平铺，动画 `skyDrift` 从 `translate3d(0,0,0)` 到 `translate3d(calc(var(--tile-w) * -1),0,0)`，位移正好一个平铺宽度 → 无缝循环。

| 层 | 时长 | 说明 |
| --- | --- | --- |
| `.c3`（远） | 540s | 最慢，几乎不动 |
| `.c2`（中） | 400s | |
| `.c1`（近） | 285s | 最快 |

`--tile-w`：桌面 1600px，窄屏 900px（`@media` 覆盖）。

> **⚠ 拷贝层必须补 `--tile-w`**：v2.29 加 `.sky-shadows` 时忘了给新容器定义 `--tile-w`，子元素宽度算出 0，整层完全不可见，排查了很久。

### 4.4 云影（v2.29）

- `.sky-shadows` 与 `.sky-clouds` 同结构、同 `skyDrift` 动画 → 影子与云逐帧同速
- 影子图是**单独的图**：`make-sky2.py` 的 `cloud_shadow_tile()` 只取云轮廓（圆 + 底椭圆），套 46 单位高斯模糊、填 `#2F4A66`，**模糊直接烘进 SVG**，不靠运行时 `filter`
- 三层：错位 20 / 26 / 32px，opacity `.14 / .20 / .24`（远淡近实）
- 雨、雪两态 `.sky-shadows { opacity: 0 }`（1.2s 过渡，与云同步淡出）

### 4.5 雨雪明暗流动（v2.28）

`.sky-precip::before` / `::after` 两层铺 `repeating-linear-gradient(90deg, 暗-亮-暗)`，元素自身 `rotate()` 造斜角，再沿本地 x 平移。

**无缝的关键：平移量 = 正好一个条带周期** `calc(var(--sheet-p) * -1)`。图案周期和位移同步，接回时严丝合缝，不会每轮“跳一下”。

| 天气 | 主层（大尺度暗涌） | 纹理层（反向） |
| --- | --- | --- |
| 雨 | `--sheet-p: 860px` / 175s / tilt -11deg，峰值 `rgba(20,46,78,.12)` | 250px / 64s / -5deg / reverse |
| 雪 | 900px / 200s / -5deg，白色高光峰值 `.15` | 380px / 110s / -3deg / reverse |

- 斜角、周期、时长、方向全不同，才不会叠成整齐梳齿
- `inset: -45% -30%`，给 11° 旋转留足余量，四角不露空
- 只动 `transform` + `will-change`，走合成器
- 晴、阴两态不生成这两层
- 雪天云本来就收起，所以高光带落在整片雪空上，观感类似“云后光扫过”

### 4.6 雨雪视差（v2.29）

`app.js` 的 `bindSkyParallax()`：`pointermove` 把指针换成 -1..1 写进 `.sky-precip` 的 `--wx` / `--wy`，一次 rAF 一帧。

CSS 用**独立的 `translate` 属性**（不与下落动画抢 `transform`），按远近乘 8 / 16 / 24px，横纵幅度不同。只有 rain / snow 生效，晴阴 `translate: none`。`mouseleave` / `blur` 归零；低动效时 JS 直接不绑。

### 4.7 改天空的正确姿势

**不要直接编辑 `css/sky.css`** —— 它是 `.workbuddy/tmp/make-sky2.py` 的产物，手改会在下次生成时被覆盖。

```
改 .workbuddy/tmp/make-sky2.py  →  python .workbuddy/tmp/make-sky2.py  →  验收截图
```

脚本里 SVG 拼接有 `%` 格式化，写 `%` 要转义成 `%%`（踩过一次，`x=-60%` 直接抛异常）。

---

## 5. 近期版本做了什么

### v2.25.0 — 备忘录/待办视觉重构
修 `.memo-t-text` 压过 `.todo-title` 的特异性问题（补 `.memo-t-text.todo-title`）。

### v2.26.0 — 课表收敛 + 水晶按键
1. 课表界面**只显示当日课程**（`keywordRowsView()` 里 `if (rowMode) courses = courses.filter(c => c.today)`），其他日期给「还有 N 节，点日期条切过去」的空态
2. 删掉关键词汇总卡 `.sched-kwsum`（连同 1370 字符的 `kwSummaryHtml()`）
3. 删掉顶栏说明句
4. 「第 N 周 编辑」→ 铅笔 SVG 图标 `i.sh-week-ico`
5. 词签行折叠成 `.kw-fold`
6. 全站按键 3D 水晶化：`--xtal-face`（顶部白雾高光 + 奶白渐变）、`--xtal-up`（顶棱高光 + `inset 0 -3px 0` 侧壁 + 落地散影）、`--xtal-down`（内凹）、`--xtal-face-sunk`（按下压暗面色）

### v2.27.0 — 交互重排 + 天气背景
1. 折叠状态写进 `settings.scheduleKwOpen`，刷新不丢
2. 按键触感：`bindHaptics()`，`pointerdown` 委托 + `HAPTIC_SEL`，`navigator.vibrate(8)`，设置开关 `haptics`
3. 文件归档改二级抽屉 `.nav-subdrawer#navSubArchive`，下方不留空白
4. 导航按 主页 → 课表 → 事件 → 信息查询 → 文档统计 → 文件归档 → 个人设置 重排
5. 扫码连电脑入口收成 `.nav-head` 里的 `.nav-qr` 图标
6. 天气驱动 3D 玻璃云背景（新建 `css/sky.css` + `js/weather.js`）

### v2.28.0 — 雨幕明暗 / 雪面高光
见 4.5。纯 CSS 伪元素，零新增 DOM、零新增请求。

### v2.29.0 — 云影 + 视差
见 4.4 / 4.6。

---

## 6. 验证：审计脚本

全部在 `.workbuddy/pw/`，都用 Playwright-core 驱动本机 Chrome：
`C:/Program Files/Google/Chrome/Application/chrome.exe`

```bash
cd .workbuddy/pw
node audit-v229.js
```

跑前先 `node server.js` 起 5173 服务。

### 主要套件

| 脚本 | 项数 | 覆盖 |
| --- | --- | --- |
| `audit-v229.js` | 16 | 云影、视差、低动效、手机端 |
| `audit-v228.js` | 22 | 雨雪明暗流动、位移实测 |
| `audit-v227.js` | 28 | 天气背景、抽屉、导航、触感 |
| `audit-v226.js` | 28 | 课表收敛、水晶按键 |
| `audit-v225.js` | 34 | |
| `audit-v224.js` | 50 | |
| `audit-v22.js` | 23 | |
| `audit-v23.js` / `v24` | 24 / 23 | |
| `audit-v16.js` / `v26` | 22 / 13 | |
| `audit-kwrow.js` | 50 | 关键词行 |
| `audit-kwfilter.js` | 34 | 关键词筛选 |
| `audit-kwmulti.js` / `kwmark` | 28 / 28 | |
| `audit-classify.js` | 24 | 文件分类 |
| `audit-fieldmap.js` | 20 | 字段映射 |
| `audit-event-edit.js` | 22 | 事件编辑 |

### 已知的既有失败（与近期改动无关，别当回归）

`audit-v17.js`（2 项）、`audit-v21.js`（3 项）、`audit-v25.js`（3 项）、`audit-display.js`（超时）

### 写审计脚本的注意点

- **必须加 `serviceWorkers: 'block'`**，否则读到的是 SW 缓存的旧 CSS，数值改了跟没改一样
- 截图脚本要 `page.route(/wttr\.in|open-meteo|geojs/, r => r.abort())`，否则 `Weather.init()` 异步把 `data-weather` 改回晴天
- `page.evaluate(fnString, [a, b])` —— 字符串函数只收一个参数，第二个被丢；用真函数 + 对象参数
- 断言留过渡时间：`opacity 1.2s` 就等 1450ms，`translate .5s` 就等 900ms
- 版本/缓存断言写「不低于」而不是「等于」，否则每次升版都误报

---

## 7. 踩坑清单（重复率最高的几条）

1. **CSS 片段替换别用「规则头 → 下一个 `}`」**。共享选择器列表里同一行会出现两次，`index()` 会命中错误那处，把整块 `content/position/inset` 吃掉、伪元素压根不生成。**改 CSS 一律整段重写。**
2. **新增图层记得补 CSS 变量**。`.sky-cloud` 宽度依赖 `--tile-w`，新容器没定义就是宽度 0、整层隐形。
3. **A/B 对比截图前先 `document.getAnimations().forEach(a => a.pause())`**。云 400ms 内漂 2px，边缘亮度差十几级，会把「加了影子」误判成「画面变亮」。
4. **特异性冲突**：`.sh-week i { font-size:11px; opacity:.7 }`（0,2,0）会压过新类，用 `.sh-week i.sh-week-ico` 提权。
5. **`background:` 简写会重置 `background-image`**。`background: linear-gradient(...)` 会把云图干掉，要单独补 `background-image`。
6. **选中态写在主色规则之前会被覆盖**，拆成「默认凸起」与「已选中内凹」两套。
7. **Python 生成器里 `%` 要转义**：SVG 里的 `x="-60%"` 在 `%` 格式化字符串里必须写 `%%`。
8. **`make-sky2.py` 的 `%s` 占位符别拼在 `%` 之后**，否则四个天气全回落到晴天。

---

## 8. 待做方向（上一轮给用户的两个建议，还没开工）

1. **云的分层视差**：给云层也加 2~4px 反向偏移（远层几乎不动、近层跟手），天空有明显纵深。复用现成的 `--wx` / `--wy`，只需多三条 CSS 规则，零 JS 改动。
2. **影子随“光源”倾斜**：晴天影子统一偏右下、阴天偏正下，并按时间（早/晚）微调偏移量。天空会显得有固定太阳方向，不加任何新资源。只改 `sky.css`（即改 `make-sky2.py`）。

---

## 9. 发版 SOP

1. 改代码（天空类改 `make-sky2.py` 后重新生成）
2. 起 5173 服务，跑新审计 + 回归近几版
3. 升三处版本号：
   - `js/app.js` → `window.APP_VERSION = '2.xx.0'`
   - `index.html` → 页脚 `工作文件 v2.xx.0`
   - `sw.js` → `CACHE = 'gongzuowenjian-vNN'`（+1）
4. 更新 `VERSION.md`：顶部三行（版本/标签/缓存）、沿革表加一行、写「vX.Y.Z 变更明细」
5. 清理探针文件（`工作文件/_*.html`、`.workbuddy/pw/_probe*.js`、临时截图）
6. 提交 + 打 tag + 推送：
   ```bash
   git add -A && git commit -m "v2.xx.0 …" && git tag v2.xx.0
   git push origin main && git push origin v2.xx.0
   ```
7. 轮询 Pages 部署（约 1~2 分钟）：
   ```bash
   curl -s "https://teluke.github.io/Dsearch/sw.js?t=$RANDOM" | grep -o "gongzuowenjian-v[0-9]*"
   ```
8. 线上验收（`_live-vNNN.js` 模板）：`APP_VERSION`、页脚、缓存号、新样式生效、零报错
9. 追加 `.workbuddy/memory/YYYY-MM-DD.md` 日志

---

## 10. 协作偏好（用户明确要求过）

- 不说废话，不用 AI 高频套话
- 每次解决问题，**同时给 1~2 个最合适、最可行、最便利的备选方案**
- 每轮改完都要验证合理性 + 完整性，再部署

---

## 附：常用命令速查

```bash
# 起服务
cd ~/Desktop/Dsearch/工作文件 && node server.js

# 重新生成天空
cd ~/Desktop/Dsearch && python .workbuddy/tmp/make-sky2.py

# 跑审计
cd ~/Desktop/Dsearch/.workbuddy/pw && node audit-v229.js

# 看某版本改了什么
sed -n '/## v2.29.0 变更明细/,/## v2.28.0/p' VERSION.md
```
