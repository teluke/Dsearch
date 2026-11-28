# 工作文件 · 项目交接文档（HANDOFF）

> 用途：删掉对话后，从这个文件就能接上进度，不用重新问一遍。
> 最后更新：2026-11-28 15:40 ｜ 当前版本：**v2.42.0** ｜ 缓存：`gongzuowenjian-v87`

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
| `.workbuddy/memory/*.md` | 当日工作日志（旧日志已归档） |
| `.workbuddy/archive/` | 瘦身前脱敏存档 + 归档的旧日志/截图/测试缓存（不入库） |
| `VERSION.md` | 版本索引 + 每版变更明细 |
| `docs/` | PRD / ARCHITECTURE / RESTORE（v2.2.1 基线） |

---

## 3. 当前状态

- 版本 `APP_VERSION = '2.42.0'`（`js/app.js` 第 4 行），页脚 `工作文件 v2.42.0`
- SW 缓存 `gongzuowenjian-v87`，清单已含三张云图：`./assets/sky/clouds-{m,t,d}-still.webp`
- `css/sky.css` 39KB（v2.40 时是 654KB，云图 base64 已全部移出）
- Git：tag `v2.42.0`（commit `832457d`），已推 `origin/main`，Pages 已生效（线上验收 34/0）
- 工作区干净，无未提交改动

---

## 3.5 首页两个抽屉（v2.39）

「近一周项目」「最近添加的文件」是 `.set-fold` 抽屉：标题行 `data-home-fold="week|recent"`，内容 `#homeBody-<key>`，状态存 `settings.homeFolds`（默认展开，收起过就记住）。点击只切类名、不重绘（`views.js` 里 `data-home-fold` 分支），「展开全部 n 个项目」与「全部」入口在 `.fold-more` 里。

## 4. 天空系统（v2.41 起：一张静止位图，不要再加动画）

### 4.1 一句话

天空 = 一层 SVG 渐变（`--sky-img`）+ **一张静止云图**（三档）。全端零动画、零 will-change、零 transform，切页 / 滚动 / 滑动查看时背景一个像素都不变。

> **⚠ v2.41 的核心约束：桌面也别再加云层动画**
> v2.27~v2.40 试过三层漂移、上下浮动、指针视差、滚动冻结，都只能把「背景偶尔爆闪」压小，压不掉。根因是背景层一边跑动画一边被重绘，合成与光栅抢资源。锁成一张静态位图之后，这类闪从机制上不存在了。想动云之前先想清楚：值不值得把爆闪换回来。

### 4.2 DOM（`index.html` 第 20–33 行）

```html
<picture class="sky-d" id="skyD">            <!-- >1200px -->
  <source media="(min-width: 1201px)" srcset="assets/sky/clouds-d-still.webp" type="image/webp">
  <img src="data:image/gif;base64,..." width="2200" height="1240" decoding="async">
</picture>
<picture class="sky-m" id="skyM">            <!-- ≤1200px -->
  <source media="(max-width: 700px)"  srcset="assets/sky/clouds-m-still.webp" type="image/webp">
  <source media="(max-width: 1200px)" srcset="assets/sky/clouds-t-still.webp" type="image/webp">
  <img src="data:image/gif;base64,..." width="1200" height="675" decoding="async">
</picture>
<div class="sky-precip"><i></i><i></i><i></i></div>   <!-- 雨雪，唯一还在动的一层 -->
```

`<picture>` 分档靠 `source[media]`：另一半屏宽不匹配时只走 `img` 的 1px 占位，**不会下载大图**。两个档的 `<img>` 都带 `width/height`，避免加载完成时把布局顶一下。

### 4.3 三档云图

| 档 | 文件 | 尺寸 | 体积 | 铺法 |
| --- | --- | --- | --- | --- |
| 桌面 >1200 | `clouds-d-still.webp` | 2200×1240 | 124KB | `object-fit:cover; object-position:50% top`，顶部对齐 |
| 平板 701~1200 | `clouds-t-still.webp` | 1200×675 | 46KB | `width:100%; height:auto; top:100px` |
| 手机 ≤700 | `clouds-m-still.webp` | 800×450 | 30KB | 800×450 定尺、`left:0; top:110px`，只露左边一段 |

- 不透明度：桌面 .42 / 移动 .32；阴天 .34 / .25 并 `filter: grayscale(.5)`；雨雪整层 `opacity: 0`（1.2s 过渡）
- 云顶位置：桌面图内 `y=190` → 1440×900 下屏上 138px（顶栏下缘 121px）；平板 `top:100` + 图内 35；手机 `top:110` + 图内 30。`audit-v241.js` 会按缩放比换算后断言
- 桌面露出四朵（x 区间 `200-630 / 760-1090 / 1180-1412 / 1560-1960`），平板图内三朵纵向分层，手机三朵横向错开

### 4.4 怎么改云

```bash
cd ~/Desktop/Dsearch
python .workbuddy/tmp/make-cloud-anim.py    # 输出 工作文件/assets/sky/*.webp
```

`SPECS` 三档，改坐标 / 宽度后重跑即可。脚本自带三条自检：相邻两朵横向不重叠、首末行列 alpha 为 0、低 alpha 像素 RGB 不偏暗（偏暗直接 `assert` 报错）。**别手改 asset 里的 webp。**

> **⚠ 贴图黑框的根因（v2.41 修掉，别再踩）**
> 有损 WebP 会把 alpha 极低的像素 RGB 压成原图的深蓝底（实测 alpha 1~30 段 RGB 均值 `45,70,98`），浏览器双线性插值把这层深色渗到云轮廓外，看着就是一圈灰黑描边、远看像矩形块。
> 修法两条：`retone()` 把 RGB 按 alpha 重新映射（alpha→0 填天空色 `176,210,240`，低 alpha 混向云白 `252,253,255`，即使渲染器完全忽略 alpha 也只看到淡蓝）；`feather()` 四周 alpha 逐像素渐隐。保存用有损 q95 + `alpha_quality=100`，存完回读校验 low-alpha 平均 RGB 最小值 > 120。
> **`retone()` 不能省**，删了黑框立刻回来。

### 4.5 天气与雨雪

- 四态写 `html[data-weather="sunny|cloudy|rain|snow"]`，由 `js/weather.js` 写
- 取数：geojs 定位 → open-meteo 天气码，单源；`geojs.timezone` 与 `Intl` 不一致 → 判走代理 → 退 `TZ_CITY`；手动城市存 `weatherCity`，优先级最高
- 雨雪：`.sky-precip` 三层瓦片 + 两条伪元素明暗带（`v2.28`），是现在**唯一还在动的背景**；雨丝下落 `skyFall`，明暗带走 `skySheetPan`，位移量都等于图案周期，接回严丝合缝
- 雨雪视差：`--wx/--wy` 写在 `#sky` 上，但 `bindSkyParallax()` 只在 `rain`/`snow` 两态才写值 —— 晴阴两态鼠标怎么动都不触发天空层样式重算
- 滚动冻结（v2.37）：`bindSkyFreeze()` 给 `html` 加 `.sky-scrolling`，`sky.css` 里 `animation-play-state: paused !important`。现在要暂停的只剩 `.sky-precip i` 与两条伪元素

### 4.6 已经删掉的东西（别再捡回来）

| 删掉的 | 原来干什么 | 为什么删 |
| --- | --- | --- |
| `.sky-float` / `@property --float-cN` / 三个 float 关键帧 | 云上下浮动 | 背景不允许动 |
| `.sky-clouds` / `.sky-shadows` / `.sky-cloud.c1~c3` + `skyDrift` | 三层漂移与云影 | 同上；顺带省掉 6 张 1600×900 纹理 |
| `--cloud-a/b/c[-grey]` / `--cloud-shadow-*` 与 9 张 base64 | 内嵌在 sky.css 里的云图 | CSS 从 654KB 降到 39KB |
| `#skyLight` + `bindSkyLight()` | 光标聚光灯 | 跟随指针就是「背景在动」，还白占一层显存 |
| `markDaypart()` / `data-daypart` | 云影按太阳高度调长 | 云影没了，留着只是每 10 分钟触发一次全站样式重算 |

## 5. 近期版本做了什么

### v2.42.0 — 主动更新 / 可点提示条 / 脱敏存档 / 工作区归档
1. SW 更新从「等浏览器自己查」改为「启动 + focus + 回前台主动 `reg.update()`」，60 秒节流
2. 发现新版显示底部可点提示条，点整条才 reload，× 只本次会话忽略；**不自动刷新**，避免打断输入
3. 瘦身前写脱敏存档 `.workbuddy/archive/现状存档-v2.41.0-20261128.md`（清单与统计，无正文/人名/IP）
4. 旧日志、旧截图、浏览器测试缓存移入归档：活跃工作区 437MB → 31MB，归档 390MB，总占用不变；代码与 backups 未动
5. `audit-v242.js` 14/14；其余有效审计全量回归见第 6 节


### v2.41.0 — 全端背景静止 / 贴图黑框 / 输入卡顿 / 查看器可编辑
1. 桌面端背景改成一张静止云图 `clouds-d-still.webp`（2200×1240/124KB），删掉三层瓦片漂移、上下浮动、指针视差、光标聚光灯；`sky.css` 654KB → 39KB，合成层从 6 张 1600×900 纹理降到 1 张
2. 修掉狗狗贴图边缘的灰黑方框：有损 WebP 把低 alpha 像素 RGB 压成深蓝底（实测 `45,70,98`），插值时渗成描边。改成 RGB 按 alpha 重映射 + 四周羽化 + `alpha_quality=100`，存完回读校验
3. 搜索输入卡到只显示拼音：组字期间不检索、只换 `#searchResults` 不重建整页、正文小写按 `updatedAt` 指纹缓存、关键词表挪进 `requestIdleCallback`、结果一次最多 60 行。查询页切页 400ms → 6ms，单次检索 10ms
4. 查看器头部加铅笔按钮，点开就是「文件详情」抽屉，保存后标题同步
5. `audit-v241.js` 38 项全过；`v230/231/232/233/234/236/237/238/239/240` 因测的是已删除的三层云而作废


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

### v2.37.0 — 滚动冻结天空动画 / 桌面三云不遮挡
1. `bindSkyFreeze()` 滚动中给 `html` 加 `.sky-scrolling`，`sky.css` 把所有天空动画 `animation-play-state` 切 `paused !important`；停手 180ms 恢复，不重置进度、不跳帧
2. 远层歪头狗 placements 从 x300/x1000 挪到 x940/x1350，桌面首屏三朵 x 区间互不重叠
3. `audit-v237.js` 20 项全过；全量回归零失败

### v2.36.0 — 滑动闪背景：天空独立合成 / 去白色光晕
1. `.sky` 改 `z-index:0` + `translateZ(0)` + `will-change:transform` + `isolation:isolate` + `contain:layout paint`；`.app` 抬到 `z-index:1`
2. 删掉 `html, body` 三道白色径向渐变和 `.app::before` 的 30px 模糊白光晕（含 `glazeDrift` 动画）；天空色只靠 `sky.css` 的 `html background-color` 兜底
3. `.appbar` 关掉所有 `backdrop-filter`，改半透明底色；滚动不再重采样天空
4. 浮动动画从 `.sky` 迁到 `.sky-float`（包住云与影），背景底图零动画；顺带修影层窄屏被写死 1600px 的问题
5. `audit-v236.js` 15 项全过；CDP 逐帧录屏确认连续滑动时背景亮度跨度 0.5、单帧最大 0.02；全量回归零失败

### v2.35.0 — 爆闪逻辑根治 / 导航串行化
1. `playViewPush()` 关键帧删掉 `opacity`，只保留 `transform: translate3d(±20px)→0`；`.view-slide` 的 `will-change` 同步去掉 opacity。整页从第一帧起不透明，亮天空不再透上来
2. `switchTab()` 拆成入队包装 + `switchTabNow()`：上一个 `Views.go()` 没完成时后续点击排队，旧任务不会抢回页面；导航点击/hashchange 改看真实 active 页与队尾目标，不再信 `Views.state.tab`
3. 不变量：任意时刻有且只有一张 active 页、active 页 opacity 恒为 1、渲染等待期旧页仍在、动画只推 transform
4. `audit-v235.js` 15 项全过；全量回归零失败

### v2.34.0 — 切页无空白 / 云匀速 / 设置页七抽屉
1. `switchTab()` 改为旧页留到新页渲染完成再撤；目标页 `.view-waiting` 脱离文档流、保留布局宽度，修掉切页时只剩亮天空的爆闪
2. 云浮动改全程 `linear` 往返（48/62/76s），去掉缓动停顿；云影仍同步、低动效仍关闭
3. 设置页文档管理 / 备份与恢复 / 局域网同步 / 数据安全四栏改抽屉，状态存 `settingsFolds`，全页共七块抽屉

### v2.33.0 — 云不变形 / 手机端避开顶栏 / 淡化 + 浮动
1. 云层高度改固定瓦片高（桌面 900px、窄屏 427.5px），`background-size` 按 `--tile-w / --tile-h` 等比铺，解决手机端小狗被压扁
2. 三层加 `--cloud-top` 落位，按瓦片内云体 y 偏移反推；手机端三层云体最上方都在顶栏下缘以下
3. 桌面晴天/阴天云透明度整体降一档，仍比手机端实、近实远淡
4. 注册 `--float-c1/c2/c3`，三层云各按 24/31/38s 缓慢上下浮动 ±5/±4/±3px；云与影共用同一位移，低动效关闭

### v2.32.0 — 三只小狗云 / 无缝轨迹 / 光影去色块
1. 三朵「云+小狗」本地抠图，保留完整云形与五官，替换手绘云；原图不入库
2. 三款云分近/中/远层，匀速左移 285/400/540s，图内两份、边缘透明，循环无半截云
3. 无损 WebP 内嵌；影层垫透明边 + 双线性缩放，消除淡蓝矩形块
4. 影子透明度降到 .035/.045/.055；阴天同形灰阶
5. 窄屏瓦片 760px、层高 46/40/34%、云透明度 .34/.30/.24

### v2.31.0 — 云影同步 / 三款新云 / 字号与切换
1. 云影叠加与云完全相同的指针视差，过渡同速（`.16s`），消除拖尾；影子更淡
2. 三款手绘单轮廓云替换旧的多圆叠色块：`big / mid / far`，各带高光、底影、细线
3. 桌面正文 17px、标题 18px；手机正文 15px，长文件/课程名可换行，右侧徽标收窄
4. `kwOpen` / `weekOpen` 合并为 `scheduleFolds: {kw, week}`，旧设置迁移一次
5. 页面切换先渲染后动画，只推 `transform/opacity`（260ms）；整页固定背景改滚动，顶栏模糊降档

### v2.30.0 — 云层视差 / 影子光源 / 界面收敛
1. 云层跟随指针反向偏移 2~4px（远层几乎不动），`--wx` / `--wy` 改挂 `.sky`
2. 影子有固定光源：晴偏右下、阴偏正下，按时段调影长
3. 课表：周次改折叠胶囊，与关键词折叠并排；顶栏搜索框与文件/关键词/编辑三键移除，「选择文件」下移到「原文件放大」标题
4. 课表：不能内嵌预览的原文件模块取消 260px 最小高度，只留一行说明
5. 设置：系列模板 / 外观与效果 / 图片文字识别 改抽屉，状态存 `settingsFolds`
6. 主页：「内容关键词关联」换「今日课表」（`coursesFor()` 与课表页共用），关键词关联表搬到「信息查询」页
7. 搜索框只在主页；其余页右上角 `#appbarSearch` 图标 → 信息查询，该页自带 `#pageSearch`

---

## 6. 验证：审计脚本

全部在 `.workbuddy/pw/`，都用 Playwright-core 驱动本机 Chrome：
`C:/Program Files/Google/Chrome/Application/chrome.exe`

```bash
cd .workbuddy/pw
node audit-v237.js
```

跑前先 `node server.js` 起 5173 服务。

### 主要套件

| 脚本 | 项数 | 覆盖 |
| --- | --- | --- |
| `audit-v242.js` | 14 | 更新条默认隐藏、关闭不刷新、主动检查与节流、真实 SW 更新出条且输入不被清掉 |
| `audit-v241.js` | 38 | 三档云图分档与零动画、贴图低 alpha 为浅色、首末行列透明、云顶在顶栏下、连切 8 页与滚动后背景几何不变、sky.css < 60KB 无内嵌云图、输入框不失焦、组字期间不检索、结果 60 行上限、查看器编辑入口 |
| `audit-v237.js` | 20 | 滚动冻结全部天空动画、停手恢复不跳帧、桌面三云区间分离、手机端同样生效 |
| `audit-v236.js` | 15 | 天空独立合成层、无白色光晕与顶栏模糊、浮动迁到 .sky-float、滑动无报错 |
| `audit-v235.js` | 15 | 整页动画无 opacity、逐帧 opacity=1、连点串行化、异步等待期旧页仍在、低动效 |
| `audit-v234.js` | 16 | 切页渲染中旧页可见、目标页离屏有宽度、匀速浮动、七块抽屉与状态记忆 |
| `audit-v233.js` | 25 | 等比铺图、手机端避开顶栏、桌面淡化、上下浮动与云影同步 |
| `audit-v232.js` | 22 | 小狗云完整性、无缝轨迹、影层无方块、灰阶与手机收敛（v233 起影层断言扣浮动量） |\n| `audit-v231.js` | 24 | 云影视差同步、三款新云、折叠对象、字号分级、iOS 式切换 |
| `audit-v230.js` | 43 | 云层视差、影子光源、课表折叠并排、设置抽屉、首页当日课表、搜索入口 |
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

`audit-v17.js`（2 项）、`audit-v21.js`（3 项）、`audit-v25.js`（3 项）、`audit-display.js`（超时）、
`audit-filters.js`（用 `#globalSearch`，但 v2.30 起搜索框只在主页，非首页 fill 必然超时）

### v2.41 起作废的脚本（测的是已删除的三层云，别当回归）

`audit-v225.js`、`v230.js`、`v231.js`、`v232.js`、`v233.js`、`v234.js`、`v236.js`、`v237.js`、`v238.js`、`v239.js`、`v240.js`

它们第 1 节就去取 `.sky-clouds .c3` / `.sky-shadows .c1`，元素不存在 → `getComputedStyle(null)` 抛错，后面整段不再执行。这些脚本覆盖的功能已由下面几套接住：

| 原脚本测的功能 | 现在由谁覆盖 |
| --- | --- |
| 云层 / 云影 / 视差 / 浮动 / 贴图分档 | `audit-v241.js` |
| 切页不空白、动画只推 transform、连点串行 | `audit-v235.js` |
| 课表收敛、日课表、关键词行 | `audit-v226.js`、`audit-v230` 的课表断言（已随脚本作废，改由 `new-ui` + `searchview` 兜） |
| 雨雪明暗流动 | `audit-v228.js`（不碰云层，仍可跑） |
| 界面骨架 / 抽屉 / 导航 | `audit-new-ui.js` |
| 搜索与筛选 | `audit-searchview.js`、`audit-kwfilter.js`、`audit-kwmark.js`、`audit-kwmulti.js`、`audit-kwrow.js` |

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
9. **切页两个坑，别只修一个**：① v2.34 前渲染等待期两页皆空，只剩亮天空；现在旧页保持可见，目标页 `.view-waiting`（`position:absolute` 离屏、保留宽度读 `clientWidth`），渲染完才换页，别把 `view-waiting` 改回 `display:none`。② v2.35 发现 `playViewPush()` 的整页 `opacity .45→1` 才是残留爆闪——页面透明，淡入时亮天空透上来；关键帧只留 `transform`，`will-change` 也别写 opacity。`switchTab()` 必须串行入队，连点时旧任务不能抢回 active；判断当前页看真实 `.view.active`，别信 `Views.state.tab`（它在 `go()` 开头就改了）。
10. **滑动闪背景查「亮底竞争」**：v2.36 前 `html` 有三道白色径向渐变、`.app::before` 有 30px 模糊白光晕、`.appbar` 有 `backdrop-filter`，天空又是 `z-index:-1` 的普通固定层；滚动时先画亮底再补合成层就会闪。现在天空独立合成层 `z-index:0`、`.app` 为 1，亮底和模糊全删，浮动动画只挂 `.sky-float`。**别再把渐变/模糊加回去，也别把云浮动动画挂回 `.sky`。**
11. **滚动冻结只切 `animation-play-state`，别重置动画**。改成 `animation:none` 或改关键帧会让云回到起点（跳帧），观感比闪更差。`paused !important` 必须覆盖 `.sky-float` / 三层云 / `.sky-precip i` 与两条伪元素，漏一条天气切换时仍会闪。`scroll` 监听要 `capture:true` 才接得住抽屉/弹窗内部的滚动。
12. **贴图边缘发黑/发灰，先查 alpha 极低处的 RGB**。有损 WebP 会把 `a<30` 的像素 RGB 压成原图底色（我们这批素材是深蓝 `45,70,98`），浏览器双线性插值时深色渗到轮廓外，就是一圈灰黑描边、远看像方块。**只查 alpha 是不够的**——alpha 全 0 不代表插值后干净。修法是生成时把 RGB 按 alpha 重映射（`make-cloud-anim.py` 的 `retone()`），保存再加 `alpha_quality=100`，并在存盘后回读校验 low-alpha 的平均 RGB。
13. **中文输入卡到只显示拼音，查「每次按键重建输入框」**。`input` 事件里整页 `innerHTML=` 会换掉 `<input>` 本身 → 失焦、组合串被清、输入法被打断。改法是只更新结果容器；同时在 `compositionstart` 到 `compositionend` 之间完全不检索（`e.isComposing` 也要判，两个信号都认），否则一次拼音会连触发好几次全库搜索。
14. **同步计算超过 100ms 的渲染块，挪到 `requestIdleCallback`**。关键词关联表要遍历全部正文（180 份实测 380ms），同步算会把切页卡住。现在先渲染 `.kw-skeleton` 占位，空闲时算完再 `outerHTML` 替换 —— 内容是同一份，用户只多等了半秒，但切页从 400ms 变成 6ms。
15. **云层 placements 别 pairwise 靠得太近**：三层云宽 190~360px，同一瓦片里若两个 x 区间重叠，近层会把远层整只压住（v2.37 前歪头狗就这样）。新排布后要截图人工核对，区间分离不等于视觉不重叠（还要看 y 与瓦片内的实际狗体边界）。

---

16. **沙箱会拦 `fs.rmSync`**：WorkBuddy 的 `node-safe-delete-shim` 在 `execFile` 子进程里会拦项目目录的递归删除，审计脚本里的 `fs.rmSync(PROFILE, {recursive:true})` 会直接抛错（单独跑反而因升级沙箱而通过，极具误导性）。改用 `fs.mkdtempSync(path.join(os.tmpdir(), 'wb-xxx-'))` 每次新建临时 profile，不要删项目目录。
17. **Playwright `page.route('**/sw.js')` 拦不到 Service Worker 脚本请求**：调试时 `swHits=0`。要模拟线上发版，只能临时改写本地 `sw.js` 再在 `finally` 里恢复，并在测试里断言恢复成功。

## 8. 待做方向（下一轮候选，都没开工）

1. **页签侧滑手势**：现在切页是按钮触发的 iOS 式 push，可以再给手机端加边缘右滑返回，方向按 `TABS` 顺序复用 `playViewPush()`。
2. **APK 打包（用户问过，未决策）**：路线与取舍见 `docs/PACKAGING.md`。默认推荐继续用 PWA「添加到主屏幕」，真要 APK 再走 Bubblewrap(TWA) 或 Capacitor。
3. **首屏 vendor 瘦身**：`index.html` 同步加载了 tesseract / xlsx / mammoth / pdf.js 共约 4MB，只有用到才需要。改成按需动态 `import()` 能把首屏脚本解析时间砍掉一大截，是可以继续挖的下一步。

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
