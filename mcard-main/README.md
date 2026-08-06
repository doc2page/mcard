<div align="center">

<img src="logo.png" width="120" alt="MCard">

# MCard

**M-Team 卡牌市场手动工具** · Chrome MV3 扩展

[![version](https://img.shields.io/github/v/release/jaxo4life/mtcard?label=version)](https://github.com/jaxo4life/mtcard/releases)
[![Chrome](https://img.shields.io/badge/Chrome-111%2B-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Manifest](https://img.shields.io/badge/Manifest-V3-34A853)](https://developer.chrome.com/docs/extensions/mv3/intro/)

🎯 定向搜索 · 💰 手动买/卖/撤 · 📦 批量买/卖/撤/改价 · 💎 魔力预算池 · 📊 交易挂单 · 📈 掉落统计 · 💹 市场数据 · 👤 用户画像 · 👁 隐私遮罩 · 🌍 双站点(.cc/.io) · 🎨 深浅主题 · 🌐 中英双语

**简体中文** ｜ [English](./README_en.md)

</div>

<p align="center">
  <a href="screenshots/market.png"><img src="screenshots/market.png" width="48%" alt="市场卡片网格"></a>
  <a href="screenshots/batch-modal.png"><img src="screenshots/batch-modal.png" width="48%" alt="批量操作"></a>
  <br><sub>市场卡片网格 + 筛选　｜　批量买 / 卖 / 撤 / 改价</sub>
  <br><br>
  <a href="screenshots/portrait.png"><img src="screenshots/portrait.png" width="48%" alt="用户画像"></a>
  <a href="screenshots/market-data.png"><img src="screenshots/market-data.png" width="48%" alt="市场数据"></a>
  <br><sub>用户画像（五维雷达）　｜　市场数据（量价走势 + 排行）</sub>
  <br><br>
  <a href="screenshots/drop-stats.png"><img src="screenshots/drop-stats.png" width="60%" alt="掉落统计"></a>
  <br><sub>掉落统计（每日柱状图 + 稀有度 / 称号分布）</sub>
</p>

> 仓库：https://github.com/jaxo4life/mtcard

直连 [M-Team 卡牌市场](https://kp.m-team.cc/cards/market) API 接口采集市场卡片、机制卡、交易记录、当前挂单、持有卡片、个人资料与魔力（Bonus）明细——**全部由你手动触发**（点刷新 / 切视图 / 买·卖·撤），无后台轮询、无定时器、无推送通道。支持**手动买/卖/撤**（限价单语义 + 魔力预算池控额）、**定向搜索**（按完整片名查在售挂单）、**交易记录 / 当前挂单 / 持有卡片**管理、**掉落概率统计**（feed 增量 + msg/search 全量双源采集，算稀有度/称号分布与活跃度）、**用户画像**（综合余额·产能·交易·掉落·符券博弈，刻财富等级/消费趋势/五维雷达）、**市场数据**（全站成交历史聚合：大盘 KPI + 时间走势 + 卡视角/人视角排行，辅助定价）、中英双语界面与深浅色主题。

## 核心原理

**API 直连采集。** 扩展通过 `mtFetch` 直连 M-Team API 接口（注入你提供的 `x-api-key`），采集市场卡片 / 机制卡 / 交易记录 / 当前挂单 / 持有卡片 / 个人资料 / 魔力（Bonus）明细——不加载市场页、不依赖网页签名。仅一处仍走 inject 拦截（开官方页捕获）：**私信搜索**（`msg/search`，官方对直连返 401，用于掉落统计全量兜底）；掉落日常增量走 `/pt-card/feed` 直连（最新 25 条，msg 最新之后）。

1. **手动触发**（点刷新 / 切视图 / 买·卖·撤）→ dashboard 发消息到 background → `mtFetch` 串行请求各稀有度市场列表（`POST /api/pt-card/market/list`，人类化随机间隔）；
2. 按稀有度分桶入库、按阈值过滤后展示在卡片网格；每次市场采集顺带刷新资料与魔力；
3. 交易记录 / 挂单 / 持有 / 掉落统计按需 `mtFetch` + 翻页衔接（`syncList`）采全；
4. **买/卖/撤**走 `mtFetch` 直连（`/api/pt-card/market/buy` · `/sell` · `/cancel`，是项目仅有的三个写操作）。

## 安装

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择项目根目录（文件夹名任意，示例 `mcard`）
4. 扩展要求 **Chrome 111+**（声明式 MAIN world content script + CSS `color-mix`）

## 使用

1. 首次打开面板会弹出**令牌设置模态**：前往 m-team 实验室（个人设置 → 实验室）生成 `x-api-key` 粘贴进来，并选择你访问的 m-team 网址（`kp.m-team.cc` / `zp.m-team.io`，按地区；API 域名自动探测可用者 .cc/.io）（令牌仅存本地、不上传，经 profile 接口验证有效后才保存）；令牌失效时面板内弹模态提示（无系统通知）。掉落统计首次 / 超 7 天会临时新开后台标签页（需你已登录 `kp.m-team.cc`），日常走 feed 直连增量
2. **点击扩展图标** → 在新 tab 打开 dashboard 全屏面板
3. **市场筛选**（市场 view 顶部筛选条）：勾选要查看的稀有度 / 机制卡 → 为每个分类设定 lowestAsk 阈值（留空=不限，点「价格阈值」弹模态设置，含预设方案保存/加载，改阈值即时生效）→ 卡片网格显示符合各分类阈值的低价卡（含海报、价格、涨跌），点击卡片跳转详情页；筛选条可按**称号**多选筛选，卡片区右上角切换按价格/按分类；点**刷新**按钮手动触发采集（无后台轮询）
4. **定向搜索**：市场 view 顶部「定向搜索」行点 `+` 输入完整片名（如「浪浪山小妖怪」），按 `/api/pt-card/market/search` 精准查在售挂单（多 tag 串行查询、合并去重、显示全部结果）；有 tag 时市场 view 切到搜索结果并隐藏稀有度/机制卡/称号/价格阈值筛选，删空 tag 回到常规市场视图
5. **手动购买**：卡片上的购买按钮走 `/api/pt-card/market/buy` 直连（限价单语义，见「手动购买与限价单语义」），从预算魔力池扣额
6. **持有卡卖出 / 挂单管理**：见「持有卡卖出与挂单管理」
7. **交易记录 / 当前挂单 / 持有卡片 / 掉落统计 / 用户画像 / 市场数据**：侧栏入口拉取成交、挂单、持有数据（含统计面板与多维筛选，卖出价按扣 5% 手续费后的净收入显示（成交价 ÷ 1.05，悬浮可查成交价），卡片可点**询价**按钮查最高买价，交易按 tradedAt、挂单/持有按最后更新时间（lastModifiedDate）排序，搜索区可切换升降序）；「掉落统计」点视图触发：日常走 `/pt-card/feed` 直连增量刷新（最新 25 条，msg 最新之后），距上次刷新 >7 天则开后台 tab 全量重采（msg/search 翻页兜底），展示历史掉落概率（稀有度/称号横向分布）、每日掉落柱状图（稀有度堆叠，7/30/90/全部可切换）与活跃度（总历时/掉落天数/最大连续/日均），并附**魔力符券使用记录**卡片（开卡数量 / 总收益 / 平均（推荐购买价）/ 中位（盈亏线）/ 单卡最高 / 最低 / 幸运倍率 / 收益波动 + 收益分布横向条形 + 历史开卡面积折线）；「用户画像」每日采集 Bonus（每小时魔力产能 finalBs，显示在资料卡魔力右下角如 `94/h`），综合余额/产能/交易收支/掉落运气/符券博弈，给出财富等级（贫穷→老钱 9 档）、消费趋势（积攒/自给/消耗/透支）与五维雷达（财力·产能·消费·运气·**博弈**——基于魔力符券开卡的赌性/欧皇度/波动，判定博弈人格未涉足/尝鲜/欧皇赌徒/过山车/苦挖并带入称号）；运气构成面板附**符券博弈摘要**（开卡数/总收益/平均/最高/最低/幸运倍率）；「**市场数据**」聚合全站成交历史（首次保存令牌后后台全量、点按钮增量），看大盘 KPI + 时间走势 + 卡视角/人视角排行（详见「市场数据」段）
8. **数据管理**：导出 / 导入扩展配置（市场筛选的稀有度/机制卡 + 价格阈值 + 预设方案）
9. dashboard 支持**深/浅色主题切换**（标题栏图标，点击切换并记忆）与**回到顶部**按钮（贴屏幕右边缘折叠，悬浮展开）

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│ background.js (service worker)                              │
│  手动触发 → mtFetch 直连 M-Team API（注入 x-api-key）       │
│   按需：市场卡片/机制卡 + profile + bonus                   │
│   按需：ensure* 采交易/挂单/持有/掉落/市场数据              │
│   写操作：buy / sell / cancel（仅此三个 mtFetch 写端点）    │
└──────────▲──────────────────────────────────▲──────────────┘
           │ chrome.runtime (message)          │ chrome.tabs（仅掉落开页）
┌──────────┴──────────────────────────────────┴──────────────┐
│ dashboard.js (全屏面板 UI)                                   │
│  令牌管理 / 配置 / 卡片网格 / 手动买卖撤 / 统计            │
│  storage.onChanged 实时重绘（按变化 key 选择性重建视图）    │
└─────────────────────────────────────────────────────────────┘

直连路径（主）：mtFetch(path, body) → POST M-Team API + x-api-key → 解析 {code:'0'} 落盘
  · 401 双重检查：HTTP 401 或 body.code==='401'（官方常返 200+code:401）→ 令牌失效模态
  · 翻页衔接 syncList：incremental（增量，新增 0 即停）/ full（按 total 翻全），LIST_MAX_PAGES 兜底

inject 路径（仅 1 处，开官方页拦截）：
  · msg/search（掉落统计）：/message/-2 页 → inject 捕获 → content 翻页转发（直连被官方 401）
```

### 按需采集流程

```
用户操作（点刷新 / 切视图 / 买·卖·撤）
  → dashboard 发消息 → background mtFetch 直连
  → 串行请求各稀有度市场列表 [随机洗牌顺序，间隔 400–900ms]，每页立即落盘
  → 入桶 / 阈值过滤 → 卡片网格展示
  → fetchProfile + fetchMyBonus（市场采集时刷新资料与魔力）
冷却：交易记录/挂单 8s、持有 30s 内不重复请求防风控
```

### 为什么这样设计（关键决策）

| 决策 | 原因 |
|------|------|
| API 直连（mtFetch + x-api-key） | 稳定快速、不加载市场页、不依赖网页签名 / 登录态刷新 |
| 401 双重检查（status \|\| body.code） | 官方常返 HTTP 200 + body.code:401，单查 status 会漏，令牌失效误判 |
| 翻页衔接 syncList（incremental / full） | 增量场景（交易记录）新增为 0 即停；全量场景（挂单）按 total 翻全 |
| 仅 msg/search 走 inject | msg/search 直连被官方 401（隐私） |
| 令牌独立 key + profile 验证 | mtApiKey 不混入 config；保存前先调 profile 验证有效才落盘 |
| 防风控冷却（交易/挂单 8s、持有 30s） | 切视图/刷新不重复请求防高频被封 |
| 买/卖/撤走 mtFetch 直连 | 不开 detail tab、不依赖页面按钮；buy 限价单语义本身保护不超价 |
| 全手动触发、无后台轮询 | 用户不操作时扩展完全静默，零风控特征、零被动流量 |

## 手动购买与限价单语义

手动购买走 `mtFetch` 直连 `/api/pt-card/market/buy`（body：filmId/rarity/provenance/price），**price = 入库的 lowestAsk**（即你点击购买时卡片的当前最低叫价）。买前仅校验 `入库价 ≤ 设定阈值`（硬上限）与预算池余额。

`buy` 是**限价单**语义（price = 最高愿付价），本身即安全门——**绝不会按高于 price 的价格成交**：盘口有 ≤price 的卖单则立即吃单成交（`status=filled`，`data.trade` 含完整成交 id/price/fee/buyerId/sellerId/tradedAt）；盘口空了或已提价则自动挂一个买单（`status=open`，返回 `orderId`、`data.trade=null`），此时立即用该 `orderId` 调 `cancel` 撤掉（重试 3 次），避免挂单被意外成交。撤单也失败则记录到 `cancelFailedOrders` 并在面板内提示手动撤销。

成交后扣减预算池、刷新该分类；交易记录仍由「交易记录」视图增量同步。失败提示（卖单不存在/已提价、请求失败、超阈值、预算不足等）以 toast 呈现。

## 持有卡卖出与挂单管理

- **持有卡卖出**：持有卡片视图每张卡有「卖出」按钮，弹窗输入**净卖价**（卖家到手；实时显示挂单价 = 净卖价 × 1.05 含 5% 手续费、抽水明细），确认后走 `mtFetch` 直连 `/api/pt-card/market/sell`（普通卡传 `cardId`、机制卡传 `mechanismCardId`，互斥）。挂单达官方上限（50）时直接提醒不弹窗；成功后刷新持有 + 挂单。
- **当前挂单管理**：当前挂单视图每张挂单有「修改」按钮，弹窗二选一——**取消挂单**（`/cancel`）或**修改挂单价**（官方无改价接口，先 `cancel` 再用新价 `sell` 重新挂出）。
- **价格格式**：卡片价格 5 位及以下完整显示，5 位以上缩写为 K/M/B（如 `100K`、`1.5M`），悬浮看完整值。

## 批量操作

持有卡片 / 当前挂单 / 市场视图**点卡片即可多选**（无需切换模式），选中后右侧浮现悬浮面板（已选 N + 操作按钮 + 清除）；批量模态内每条可 ✕ 删除。

- **市场 · 批量购买**：选中多张 → 各自最低叫价（lowestAsk）串行买入，提交前校验总花费 vs 可用预算；限价单语义保证不超价，盘口变动未成交显示灰色「未成交」（不进重试集）。
- **持有 · 批量卖出**：选中多张 → 顶部按稀有度/称号批量设净价（或逐项填）→ 串行上架；卖出新增挂单，校验 50 挂单上限。
- **挂单 · 批量取消**：选中多单 → 串行撤单。
- **挂单 · 批量改价**：选中多单 → 设新净价 → 每单先撤再用新价重挂（cancel + sell 两步）。
- **持有 · 批量锁定**：选中多张 → 锁定（磨砂蒙版标记，不可选中/操作，防止平时误卖）；状态跨会话持久；解锁需两步点击确认防误点。

步骤级串行执行 + 项间防风控随机延迟 + 逐项步骤状态（撤单 ✓/✗ · 挂单 ✓/✗ · 购买 ✓/未成交）；某步失败跳过该单继续，**失败精准重试**（改价撤 ✓ 重挂 ✗ 时只重试重挂，不重复撤单），支持单项或重试全部失败。改价撤 1 挂 1 净挂单数不变，不受 50 上限约束。

## 预算魔力池

- `total`（总额）/ `spent`（已花），可重置。
- **可用额度** = `min(total - spent, 账户余额)`（background 与 dashboard 同一口径）。
- 拦截点：手动购买前端拦截 + background 后端兜底。
- 顶栏进度条按可用占比着色（绿/黄/红），账户余额不足以覆盖预算剩余时降色警告。
- 令牌失效通过**面板内模态**提示（无系统通知、无推送）。

## 市场数据

汇聚全站卡片成交历史（`/api/pt-card/market/tradeHistory`），三区叙事呈现市场微观结构：**市场总览**（脉搏叙事条 + 核心 KPI + 市场结构[鲸鱼度 / 买卖家重叠 / 抽水率] + 量价叠加走势图[柱按稀有度·机制卡堆叠分色 + 均价折线 + 价格分布直方图 + 24 小时分布]）、**价格分析**（价格分位[低价位/高价位/高位价/波动，悬浮看释义] + 稀有度·机制卡 3 类基准矩阵 + 卡视角排行[最贵/热门/成交额/流通，热门按影片归总，附流动性日均·间隔] + 成交之最[买卖家 uid 可点跳资料页]）、**玩家行为**（我的市场画像[买/卖卡数·额·均价 + 净盈亏 + 市场份额 + 倒卖次数·套利额·毛利率·持有天数] + 卡视角 / 人视角排行[买/卖 4 榜 + 倒卖榜]）。8 个分析维度：倒卖识别（同卡 FIFO 配对·毛利）、集中度（top-10 占比 + HHI）、价格分布、7 日趋势环比 + 领涨稀有度、买卖家重叠、稀有度基准、卡视角流动性、手续费。排行支持搜索（卡视角模糊搜片名 / 人视角精确搜 uid + 该 uid 成交订单流水），列表固定高度、滚动到底自动加载更多，各排行榜与各 tab 的滚动位置相互独立保持。全局筛选（稀有度 / 来源 / 称号 / 日期，一处筛选全维度联动）。首次保存令牌后后台静默全量采集，之后点按钮增量更新。

**交易记录查询 tab**：市场数据 view 顶部 tab 切换（市场总览 / 交易记录查询）。交易记录查询支持按稀有度/来源/称号/日期筛选 + 片名或 UID 搜索 + 买入/卖出方向筛选（搜 UID 时方向相对该 UID：作买家=买入、作卖家=卖出；未搜时按 buyOrderId 判定：为 null=买方主动吃卖单=买入、有值=卖方主动吃买单=卖出），9 列金融数据感表格（时间/片名/稀有度/称号/买家/卖家/价格/手续费/方向，稀有度彩色标签 + 方向药丸 + zebra 隔行 + 表头吸顶）按时间倒序，每页 50 条分页，时间列、价格列均可点排序（点列头切换升降序，从价格排序点回时间列即恢复默认倒序），搜 UID 时买卖格命中高亮（浅绿底），买家/卖家 uid 可点跳资料页。筛选条件独立于「市场总览」tab。

## 数据 & 隐私

- 采集与交易/挂单数据仅存本地（`chrome.storage.local`）。
- 扩展不读取、不存储账号密码，只复用浏览器已有的 M-Team 登录 cookie（仅掉落统计全量兜底临时开 `/message/-2` 页时用）。
- 扩展**不向任何外部服务器上报数据**——无推送通道、无代理转发、无系统通知。所有采集与写操作仅在你手动触发时发生。
- 本地存储键：`config`（市场筛选/阈值/预设/预算/语言/定向搜索设置）、`mtApiKey`（API 直连令牌，独立 key，不进 config）、`buckets`/`mechBucket`（各分类最新市场结果）、`history`（采集事件日志）、`buyHistory`（交易记录）、`ordersAll`（挂单）、`inventory`/`mechInventory`（持有卡片/机制卡）、`profile`（账户资料）、`stats`（采集统计）、`dropStats`（掉落统计：原始消息表 + 概率/活跃度聚合）、`bonus`（用户 Bonus：finalBs 每小时产能 + 全量明细）、`cancelFailedOrders`（撤单重试全失败的残留挂单记录）。

## 配置

- **市场筛选**：稀有度（UR/SSR/SR/R/N）、机制卡（魔力符券/置顶免费符/VIP七日符）、每分类价格阈值（lowestAsk ≤，留空=不限）、阈值预设方案（命名保存/加载/删除）
- **定向搜索**：tag 列表（完整片名，多 tag 串行查询合并去重）
- **预算魔力池**：总额、重置
- **令牌**：x-api-key（独立 key，经 profile 验证有效后才保存）
- **显示模式**：按分类 / 按价格
- **主题**：深 / 浅
- **语言**：中 / 英
- **数据管理**：导出 / 导入仅扩展配置（市场筛选的稀有度/机制卡 + 价格阈值 + 预设方案；不含业务数据，业务数据均可从 API 重采）；导入兼容旧版导出文件（自动忽略已废弃字段）

## 调试

所有日志带 `[MTEAM]` 前缀：

- **Service worker 日志**：`chrome://extensions` → 本扩展 → "Service Worker"（看 `market data received` / `buy` / `sell` / `cancel` / `tab created` / `tab closed`）
- **页面日志**：掉落全量采集时后台 tab 控制台可见 `inject success` / `fetch captured` / `xhr captured`（tab 用完即关，需抓住存活的那十几秒）
- **数据**：dashboard 面板直接展示，或 `chrome.storage.local.get(null)` 在 SW 控制台查看全量

## 文件结构

```
mcard/
├── manifest.json       # MV3 清单（tabs/storage 权限、双 world content script、default_locale）
├── background.js       # SW：mtFetch 直连采集 / 令牌管理 / buy·sell·cancel / 预算 / 掉落·市场数据按需采集
├── content.js          # ISOLATED：msg/search 翻页 + INJECT_READY 握手（仅 /message/-2 页）
├── inject.js           # MAIN：仅拦截 msg/search（掉落全量兜底）；其余采集（含买卖撤）均已直连
├── shared.js           # 共享常量与工具（稀有度 / 机制卡 / computeUsable / t·applyI18n）
├── dropStats.js        # 掉落统计纯逻辑（msg context 解析 + feed 卡片 + summary 双源聚合，自包含可单测）
├── marketStats.js      # 市场数据纯逻辑（tradeHistory 聚合：KPI + 走势 + 卡/人视角排行，自包含可单测）
├── portrait.js         # 用户画像纯逻辑（财富等级 + 消费趋势 + 五维雷达 + 标签，自包含可单测）
├── dashboard.html      # 全屏面板（点击扩展图标在新 tab 打开）
├── dashboard.css       # 深色交易终端风格 + 浅色主题（纯 CSS 变量驱动）
├── dashboard.js        # 面板逻辑（手动刷新 / 卡片网格 / 阈值 / 手动买卖撤 / 统计）
├── theme-bootstrap.js  # 主题首帧引导（消除首屏闪烁；MV3 CSP 禁内联，须外部脚本）
├── lang-bootstrap.js   # 语言首帧引导（<head> 同步设 <html lang>，消除切语言闪烁）
├── locales/            # 应用 i18n 字典（dashboard 文案）：zh.js + en.js（缺 key 回退另一语言）
├── _locales/           # MV3 原生 i18n（扩展名 / 描述）：zh_CN + en 的 messages.json
├── logo.png            # logo（dashboard / 工具栏）
└── docs/               # 设计文档（本地保留，已 gitignore，不入仓库）
```

## 权限说明

| 权限 | 用途 |
|------|------|
| `tabs` | 开后台 tab（掉落统计全量兜底拉取，不激活前台）、检测 tab 关闭/跳离 |
| `host_permissions` | M-Team API 接口（双站点 .cc/.io，直连采集 + buy/sell/cancel）、`kp.m-team.cc` / `zp.m-team.io`（掉落统计开 `/message/-2` 页） |
| `storage` | 本地存储全部状态（SW 会休眠） |

## 已知限制与后续扩展

- 交易记录视图有完整搜索（文本 + 日期 + 精确/模糊）；市场 view 支持按完整片名**定向搜索**（查 `/market/search`），但常规市场采集仍是稀有度/价格/机制卡维度。
- 卡牌字段（id/name/price）采用**尽力提取**策略（扫描常见字段名）。若 M-Team 实际字段名不同，调整 `background.js` 的 `idOf/nameOf/priceOf`。

## 风险与合规

- 本扩展仅用于个人查看/操作自有账号可见的市场数据，**不绕过任何访问控制、不破解签名**。
- 手动买/卖/撤按你设定的阈值与预算经 `buy`/`sell`/`cancel` 直连下单，不构成"加速抢购"或绕过风控。
- 自动化访问任何站点都可能触发对方风控，滥用风险自负。
