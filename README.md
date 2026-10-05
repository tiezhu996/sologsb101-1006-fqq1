# 地铁隧道环片裂缝复测台账（sologsb101-1006）

面向地铁运营隧道结构维保班组与第三方监测单位，把区间内每环管片的裂缝逐条建档，并按测次复测比对裂缝发展情况。核心动作：录入区间与环片里程、登记裂缝部位与走向、按测次复测宽度长度、算发展速率、给出整治建议。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22806**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 | `<script setup>` + Composition API |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `vue-tsc --noEmit` |
| UI 组件 | Element Plus 2.9 | 表格、表单、弹窗、抽屉、标签、进度 |
| 状态管理 | Pinia 2.3 | `sectionStore` / `crackStore` / `surveyStore` / `replacementStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1006/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbtunnelcrack
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # section.ts ring.ts crack.ts survey.ts advice.ts replacement.ts
        ├── stores/             # sectionStore.ts crackStore.ts surveyStore.ts replacementStore.ts
        ├── components/common/  # LevelTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── components/replacement/  # ReplacementWizard.vue（换环登记—预览—确认向导）
        ├── hooks/              # useCrackTrend.ts useIdbTable.ts
        ├── pages/              # SectionList.vue ReplacementManage.vue CrackEntry.vue SurveyCompare.vue TrendBoard.vue BackupView.vue
        ├── router/index.ts
        ├── utils/              # rate.ts db.ts export.ts replacement.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/sections` | 区间与环片里程台账 | Section、Ring | 新建/编辑/删除区间与环片；按线路、结构型式筛选；里程区间二维筛选；展开环片查看裂缝；「含已换环历史」开关查看留档环；对当前环发起换环 |
| `/replacements` | 换环管理（大修整环更换） | Replacement、Ring、Crack、Survey、Advice | 登记换环日期/原因/新环安装信息 → 预览受影响裂缝、复测、整治建议 → 确认后原环整体留档、新环沿用原环号从零建档；失败保留单据可重试、未确认可作废 |
| `/cracks` | 裂缝初测录入 | Crack、Ring | 新增/编辑/删除当前环裂缝；已换环历史裂缝只读附带；勾选批量改状态；单条状态流转（观察→待整治→已整治）；导出 CSV |
| `/surveys` | 复测测次与变化量对比 | Survey、Crack | 按测次追加读数（自动比对生成变化量）；SVG 折线对比历次宽度；编辑/删除测次；已换环历史复测只读可查 |
| `/trends` | 发展速率分级与预警 | Crack、Survey、Advice | 按月均速率降序排行（仅当前环计入预警）；仅看预警开关；一键生成整治建议草稿；抽屉查看测次序列 |
| `/backup` | 整治建议与数据备份 | 全部模型 | 建议状态流转（待下发→已下发→已完成）；导出/导入全量 JSON（兼容旧版备份升级）；导出 CSV；清空/重置演示数据 |

### 换环版本口径（v3）

- **登记不写入**：换环单先存为「待确认」，只记录换环日期、原因与新环安装信息（管片类型、安装日期、里程、施工单位），不改动任何环片/裂缝数据。
- **预览后确认**：确认页固化并展示受影响的裂缝、全部复测、整治建议；登记后范围发生变化（漂移）必须重新预览；跨环/跨区间、缺安装信息、日期顺序不合法一律拒绝写入。
- **原环留档 / 新环建档**：确认在单事务内完成——原环置为「已换环（历史留档）」只读，其裂缝与全部复测仍按**原环片 id** 查询；新环沿用原环号、世代号 +1、与原环共用血缘链，从零建档，旧记录不会错挂到新环。
- **失败可重试**：确认失败时事务整体回滚，换环单（含已确认范围快照）保留为「确认失败」，重试凭单据与血缘链幂等，不重复建环。
- **当前环 vs 已换环历史**：区间台账、裂缝录入、复测对比、速率预警、整治建议默认只统计/写入当前环；打开各页「含已换环历史」开关可只读查看历史；CSV 导出含「环片世代 / 环片状态 / 换环日期」列，全量 JSON 备份含 `replacements`。

## 五、数据存储说明

- **IndexedDB 库名**：`gbtunnelcrack`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`sections`、`rings`、`cracks`、`surveys`、`advices`、`replacements`（换环单）
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1)` → `version(2)`：补齐行修订号 `revision`、用所属环片回填历史裂缝的 `sectionId` 冗余列、补齐缺失的变化量字段
  - `version(2)` → `version(3)`：新增 `replacements` 换环单表，`rings` 增加 `status / generation / lineageId / replacedById / replacementId` 索引；升级时既有环片统一补为「当前环·第 1 代」并以自身 id 建立血缘链，**裂缝与复测的环片归属一律不动**
- **旧备份兼容**：导入 v1/v2 全量 JSON 时，无换环字段的环片自动补为当前环首环、无 `replacements` 按空处理，旧裂缝/复测保持原 `ringId/crackId` 归属，不会错挂到换环后的新环片
- **首屏自动播种**：`initDatabase()` 中 `if (await db.sections.count() === 0) await seedDatabase()`，播种 2 个区间 → 6 个环片（含一对已完成换环的第 118 环：原环留档 + 第 2 代当前环）→ 6 条裂缝 → 14 个测次 → 4 条建议 → 1 张已确认换环单的演示数据；播种为幂等操作，重复调用不会重复插入
- **localStorage 辅助键**：`gbtunnelcrack:db-version`（结构版本号）、`gbtunnelcrack:last-backup-at`（最近备份时间）、`gbtunnelcrack:ui-prefs`（上次选中区间、仅看预警开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷；清理浏览器数据即清空业务数据（可在 `/backup` 页重新播种）

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22806
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

> 提示：开发时浏览器直接使用本机 IndexedDB；若与 Docker 版本混用同一浏览器，数据是同一份（同源端口不同则为不同源，数据互相独立）。

## 七、判定口径

- 月均速率 `mm/月 = (本次宽度 − 上次宽度) ÷ 间隔天数 × 30`
- 分级阈值：`< 0.10` 一般，`0.10 ~ 0.25` 较重，`≥ 0.25` 严重
- 预警数 = 速率分级为「较重」及以上的裂缝数量
