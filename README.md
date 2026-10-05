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
| 状态管理 | Pinia 2.3 | `sectionStore` / `replacementStore` / `crackStore` / `surveyStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种，DB v3 含换环单与环片生命周期 |
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
        ├── stores/             # sectionStore.ts replacementStore.ts crackStore.ts surveyStore.ts
        ├── components/         # ReplacementWizard.vue（换环三步向导）
        │   └── common/         # LevelTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useCrackTrend.ts useIdbTable.ts
        ├── pages/              # SectionList.vue RingReplace.vue CrackEntry.vue SurveyCompare.vue TrendBoard.vue BackupView.vue
        ├── router/index.ts
        ├── utils/              # rate.ts db.ts export.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/sections` | 区间与环片里程台账 | Section、Ring、Replacement | 新建/编辑/删除区间与环片；按线路、结构型式筛选；里程区间二维筛选；展开环片查看裂缝；当前在役环/已换环历史切换；对在役环发起换环 |
| `/replacements` | 换环管理 | Replacement、Ring、Crack、Survey、Advice | 登记换环日期/原因/新环安装信息；预览受影响裂缝、复测、建议；确认后原环整体留档、新环沿用原环号从零建档；失败单保留范围可重试、不重复建环 |
| `/cracks` | 裂缝初测录入 | Crack、Ring | 新增/编辑/删除裂缝（仅限在役环）；勾选批量改状态；单条状态流转（观察→待整治→已整治）；当前裂缝/已换环历史切换；导出 CSV |
| `/surveys` | 复测测次与变化量对比 | Survey、Crack | 按测次追加读数（自动比对生成变化量）；SVG 折线对比历次宽度；编辑/删除测次；换环前历史裂缝只读 |
| `/trends` | 发展速率分级与预警 | Crack、Survey、Advice | 按月均速率降序排行；仅看预警开关；当前环/已换环历史切换；一键生成整治建议草稿；抽屉查看测次序列 |
| `/backup` | 整治建议与数据备份 | 全部模型 | 建议状态流转（待下发→已下发→已完成）；导出/导入全量 JSON（兼容旧版备份并做引用完整性校验）；导出 CSV；清空/重置演示数据 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtunnelcrack`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`sections`、`rings`、`cracks`、`surveys`、`advices`、`replacements`（换环单）
- **环片版本（换环）口径**：`rings.lifecycle` 区分 `current`（在役）/ `archived`（换环留档）；换环不迁移任何裂缝、复测、建议，新环用换环单预生成的 `newRingId` 从零建档并沿用原环号；原环通过 `replacedById / successorRingId` 与新环双向溯源，老记录始终按原环片在「已换环历史」中可查。裂缝台账、复测、速率预警默认只统计在役环，历史数据只读。
- **换环单状态**：`待确认`（仅登记信息）→ 确认执行 → `已完成`；执行失败置 `失败` 但保留单据与 `confirmedCrackIds` 确认范围，重试按 `newRingId` 幂等、不重复建环；未确认、跨环冲突、缺少安装信息一律不写入。
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的迁移：v2 补齐行修订号与冗余列，v3 新增 `replacements` 表并为历史环片补 `lifecycle=current`。导入旧版 JSON 备份时自动归一（无换环单按空数组、无生命周期按在役），并校验裂缝/复测/建议的引用完整性，父环缺失直接拒绝导入，防止旧记录错挂到新环片。
- **首屏自动播种**：`initDatabase()` 中 `if (await db.sections.count() === 0) await seedDatabase()`，播种 2 个区间 → 6 个环片（含 1 个换环留档环 + 1 个换环新装环）→ 8 条裂缝 → 16 个测次 → 5 条建议 → 2 张换环单（1 张已完成、1 张待确认）的互相引用演示数据；播种为幂等操作，重复调用不会重复插入
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
- 预警数 = 速率分级为「较重」及以上的**当前在役环**裂缝数量；已换环留档裂缝的历史预警单独在历史范围展示，不与新环混算

## 八、换环版本流程

1. **登记**：`/replacements` 或在区间台账对在役环点「换环」，填写换环施工日期、原因与原因说明、新环里程/管片类型/安装日期（厂家/批次/施工单位选填）与确认人。校验不通过（原环不存在、已是留档环、同环已有进行中换环单、同区间在役环撞号、缺安装信息）时不写任何数据。
2. **预览**：汇总原环裂缝、复测次数、整治建议及末次速率，必须勾选确认范围后才能继续。
3. **确认执行（事务）**：原环置 `archived` 整体留档（裂缝/复测/建议一行不动），新环按预生成 id 建档（沿用原环号、零裂缝零复测）。先单独落「确认范围」，再执行原子事务；事务失败时单据置 `失败` 并保留范围与错误信息，重试按新环 id 幂等。
4. **查询与导出**：换环前裂缝与全部复测在各页「已换环历史」范围按原环片只读可查；区间台账、复测对比、速率预警、整治建议与 CSV/JSON 导出均区分当前环与已换环历史；旧版备份导入自动升级并做引用完整性校验。
