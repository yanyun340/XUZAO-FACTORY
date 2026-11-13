# 设计参考库：scaffold-master

来源：`github.com/wbr664393425-lgtm/scaffold-master`（MIT，Spring Boot + Vue 后台脚手架）。
抽取日期：2026-11-12。

**本目录只作结构参考，不参与构建，不可被 `src/` 引用。**

## 硬约束

1. **禁抄配色、材质、动效。** 本项目是「纸张底色 + 深松绿 + 朱砂 + 宋体标题」的工业信息密度基线；参考源是「珍珠玻璃 + 蓝青柠 + SF Pro」。两套语言互斥，混用即破坏一致性。
2. **禁引入第二套令牌。** 任何借鉴项必须映射到 `src/styles.css` 的既有 token；确需新增时，只能新增**类别**（如阴影档位、密度），不能新增**色板**。
3. **禁整文件复制 CSS。** 参考的是类名契约与结构，实现按本项目既有选择器重写。
4. **禁引入 GSAP。** 本项目动效为纯 CSS + `prefers-reduced-motion`，维持现状。（GSAP 另有非 MIT 许可问题。）

## 文件清单

| 文件 | 读什么 |
| --- | --- |
| `DESIGN.md` | 七层样式表职责划分、令牌语义分类（状态色 vs 分类色）、仪表化语汇的定义与使用边界、文案规则（无英文眉标、无 `01/02` 编号、等宽只给数字/编码/时间） |
| `css/tokens.css` | 令牌的**分类方式**：字色四档、语义色三角（主操作/状态/警示）、圆角 5 级、阴影 3 档（接触 + 环境）、仪器化排版、分类色 vs 状态色的分离 |
| `css/components.css` | 控件状态覆盖清单（default/hover/active/focus/disabled/invalid）、表格密度、浮层结构 |
| `vue/DataTable.vue` | 列配置驱动的 props 契约、`<table>` 语义结构、密度切换、空态与操作列处理 |
| `vue/Pagination.vue` | 分页的受控 props 契约与边界态（首页/末页/总数） |
| `vue/Segmented.vue` | 分段控件的受控值与无障碍（radiogroup 语义） |

## 令牌映射表

左边是参考源的令牌，右边是本项目已存在的等价物（**优先用右边**）。

| 参考源 | 本项目 | 处理 |
| --- | --- | --- |
| `--ink` / `--ink-muted` | `--ink` / `--ink-2` / `--muted` | 已覆盖，用本项目的 |
| `--ink-soft` / `--ink-faint` | 无 | 暂不新增，用 `--muted` + 透明度 |
| `--blue`（选择 / 主操作） | `--pine` `#1c3a30` | **语义映射**：主操作 = 松绿，不是蓝 |
| `--leaf-text`（正常态文字） | `--green` / `--teal` | 语义映射 |
| `--red` / `--red-text`（警示） | `--vermilion` `#bf5530` | 语义映射 |
| `--r-xs…xl` | `--radius-sm…xl` | 已覆盖（本项目 4 级） |
| `--e1 / --e2 / --e3` | **无** | **建议新增**：三档阴影（接触 + 环境），替换散落的 `box-shadow` 字面量 |
| `--fs-display-xl/l/m` | **无** | 建议新增：56 / 40 / 28px 三档读数 |
| `--font-mono` | `--font-mono` | 已覆盖 |
| `--row-h` / `--cell-px`（三档密度） | **无** | **建议新增**（阶段 2.3） |
| `--plate-bg` / `--plate-ink` | **无** | 建议新增，但改为深松绿面（`--pine-2`），不是深色玻璃 |
| `--hatch` / `--tick` | **无** | 建议新增：斜线填充与刻度线，只承载"区间/当前值"语义 |
| `--cat-1…5`（分类色） | 部分重叠（`--violet` / `--cyan` / `--orange`） | **只借概念**：分类色不得用于状态表达 |

## 七层分层 → 本项目现状映射

本项目目前是单个 `src/styles.css`（4,960 行），已有天然的注释分界，可直接按参考源的分层切开：

| 参考源层 | 本项目现有区块（行号为拆分前） | 备注 |
| --- | --- | --- |
| `tokens` | 7–45（`:root`） | 拆完补密度/阴影/字号类别 |
| `base` | 46–195（reset、纸面颗粒 68、排版基线） | — |
| `materials` | 面板、卡片、浮层相关段 | **不引入玻璃配方**，只保留纸面材质 |
| `components` | 196（按钮）、311（表单）、1593（状态徽章）、1362（表格） | 附控件状态覆盖清单 |
| `instruments` | **无** | 新增层：读数、铭牌、刻度尺、斜线、环比胶囊 |
| `layout` | 467（顶栏）、1031（应用骨架） | — |
| `pages` | 443（登录）、1807（新建订单）、2039（订单详情）、2559（基础数据）、4065（账号）、4237（审计）、4614（待办台） | — |

## 采纳进度

- [x] **2.1** 拆分 `styles.css` 为八层（2026-11-12）。切分按原文行号连续覆盖，构建产物哈希与拆分前完全一致（`0ce15e66…`）。
- [x] **2.2** 抽 `DataTable` + `Pagination`（2026-11-12）。语义 `<table>`，视觉像素级不变（headless Chrome A/B 截图哈希一致）。已迁移：`InventoryPage` 配件表、商品表、分页。
- [x] **2.3** 密度令牌 `--row-py` 三档（2026-11-12）。默认档等于原 14px，实测紧凑档行高 71→61px。
- [x] **2.2b** 其余表格迁移完成（2026-11-12）：`AuditLogPage`（展开详情改为独立 `<tr><td colSpan>`）、`BaseDataPage` 五个变体、`OrderDetailPage` 产品明细、`InventoryPage` 流水表。桌面 1100 / 移动 430 两档、每类表各含展开态，与原 div 结构截图逐像素一致。
  - `DataTable` 新增：`expansion`（跨列附加行）、无 `title` 时自动省略 `thead`、`headClassName` 改为可选。
  - 最小宽度默认回落到 0，交由各页既有的 `.xxx > *` 规则控制（`minWidth` 仍可覆盖）。
- [ ] **2.4**（可选）`instruments` 层：`Odometer` / `DeltaPill` / `SpecPlate` / `Ruler`，优先用于订单详情「流转台账」

## 落地记录

| 文件 | 作用 |
| --- | --- |
| `src/styles/{tokens,base,components,layout,tables,pages,responsive,pages-extra}.css` | 由原单文件按行号连续切分，导入顺序见 `src/main.tsx`；顺序与原文一致，cascade 不变 |
| `src/components/DataTable.tsx` | 列配置驱动，渲染原生 `<table>`；样式类由调用方注入，故各页视觉不变。支持 `expansion` 附加行、无表头模式、`minWidth` |
| `src/components/Pagination.tsx` | 受控分页，取代各页复制的 `.pager` 块 |
| `src/styles/tables.css` 末尾 | `.table-semantic` 语义表格适配（`:where()` 零特异性重置，避免压过既有规则）与 `.table--compact` / `.table--comfortable` 密度档 |

## 不采纳清单

| 项 | 原因 |
| --- | --- |
| 蓝 / 青柠 / 玫瑰色板、玻璃材质 | 与纸感松绿基线互斥 |
| GSAP 动效体系 | 现有纯 CSS 方案已合规；另有许可风险 |
| `NeuralNet` / 权限图谱 Canvas | 装饰性复杂度，与工业信息密度相反 |
| `PermissionButton` / `DictSelect` / `DeptTree` / `PermissionTree` | 依赖其 RBAC 后端模型，本项目为 Fastify + Prisma，模型不同 |