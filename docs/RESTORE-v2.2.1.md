# 工作文件 · 版本存档与恢复指南

本文件说明如何把这个项目的某一版本完整找回、重建或重置。

---

## 1. 存档构成

| 存档物 | 位置 | 用途 |
| --- | --- | --- |
| Git 仓库（含全部历史与标签） | `Dsearch/.git` | 日常版本管理、任意版本回退 |
| 版本标签 | `v1.4` … `v2.2.1` | 精确锁定某一版 |
| 单文件仓库快照 | `Dsearch/backups/dsearch-v2.2.1.bundle` | 整仓打包，可脱离本机恢复 |
| 源码快照 zip | `Dsearch/backups/workfile-src-v2.2.1.zip` | 不含 git 的纯源码，直接部署用 |
| 文档 | `docs/`、`PRD.MD`、`DEV_PLAN.MD` | 架构、需求、计划 |

> `backups/` 已被 `.gitignore` 排除，不会进入版本库，避免仓库自膨胀。

---

## 2. 当前版本快照（v2.2.1）

| 项 | 值 |
| --- | --- |
| Git tag | `v2.2.1`（`git rev-parse v2.2.1` 得到存档提交） |
| SW 缓存 | `gongzuowenjian-v19` |
| IndexedDB schema | version 3 |
| 线上地址 | （私有部署，地址与访问口令不入库） |
| 部署方式 | node 静态服务（`工作文件/server.js`，端口 5173） |

---

## 3. 恢复某一版代码

### 方式 A：本机 git（推荐）

```bash
cd ~/Desktop/Dsearch

# 看所有存档点
git log --oneline
git tag

# 临时查看某一版（不动当前工作区）
git switch --detach v2.2.1

# 回到最新
git switch main
```

### 方式 B：从 bundle 克隆（换电脑 / 仓库损坏时）

```bash
# 用 bundle 里的历史克隆出一个新仓库
git clone backups/dsearch-v2.2.1.bundle dsearch-restore

cd dsearch-restore
git tag                 # 应能看到 v2.2.1
git log --oneline -5
```

### 方式 C：只要源码，不要历史

解压 `backups/workfile-src-v2.2.1.zip`，得到 `工作文件/` 目录，直接：

```bash
cd 工作文件
node server.js           # http://127.0.0.1:5173
```

---

## 4. 回退线上版本

```bash
cd ~/Desktop/Dsearch

git switch --detach v2.1        # 或任意历史 tag
# 重新部署：工作文件 目录作为静态站点根，language=node，端口 5173
```

⚠️ 回退部署后，**手机端需要关闭应用重开**，让新的 Service Worker 缓存生效。

---

## 5. 数据重置（三个层级，按需选择）

### L1 只清缓存 / 强制拿最新前端（不动数据）

- 桌面：DevTools → Application → Service Workers → Unregister，再勾选 Update on reload。
- 手机：彻底关闭 PWA（多任务里划掉）后重开；仍无效则删除桌面图标，重新用链接「添加到主屏幕」。

### L2 清空应用数据（记录全丢，先备份！）

- 桌面：DevTools → Application → Storage → Clear site data。
- 手机：设置 → 应用管理 → 找到该 PWA → 清除数据（iOS 用 Safari 设置里的网站数据）。

### L3 恢复业务数据（不是代码）

1. 打开应用 → 个人设置 → 备份与恢复 → 导入备份 zip；
2. 或使用局域网同步从另一台设备拉回。

---

## 6. 自检清单（恢复后确认）

- [ ] 首页正常渲染，待做事项在最上方
- [ ] 顶部搜索能命中文件名/正文/图片文字
- [ ] 打开一份 docx / pdf / xlsx，查看器可正常显示
- [ ] 个人设置 → 关于，版本号与目标版本一致
- [ ] DevTools → Application → Cache Storage，缓存名与 `sw.js` 中的 `CACHE` 一致

---

## 7. 关键「防丢」约定

1. **改前端必改 `sw.js` 的 `CACHE` 版本号**，否则老缓存不更新。
2. **不进部署目录**：`tests-workfile/`、`.workbuddy/`、`backups/`。
3. **定期导出备份 zip**：清浏览器数据会连同 IndexedDB 一起清掉，代码可恢复、数据不可恢复。
4. **打 tag 再做大改建**：`git tag -a vX.Y -m "说明"`，回退成本最低。
