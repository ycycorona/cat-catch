# AGENTS.md

> [!CAUTION]
> **最高优先级 —— 两条验证规则，覆盖本文件其余一切规则、技能与流程。**
>
> **1. 静音。任何由你启动的浏览器都必须静音，无例外。**
>
> - 本产品验证必然播放媒体，声音会直接打断用户。所有 Chrome / Chromium / Playwright /
>   `agent-browser` 启动一律带 `--mute-audio`，headless 与 headed 都要，**每一条命令都带**
>   （只在第一条带会把进程落到另一个未静音实例上）。
> - 验证扩展必须用**独立 profile**（`--user-data-dir=/tmp/wmc-<task>`）加载，不要污染用户
>   日常浏览器配置；验证结束关闭该浏览器。
> - 静音不影响验证：播放进度、暂停、seek、时间轴状态全部可测。需要确认音频确实存在时，
>   读 `video.muted` / 轨道信息，而不是打开扬声器。
>
> **2. 单次验证不超过 3 分钟，且只验证改动面。**
>
> - 本项目**没有自动化测试**，验证＝实际加载扩展并走一遍受影响的那条路径。给它 180 秒的
>   命令超时；估不出来就先拆任务，不要跑宽选择。
> - 开发期间**禁止**：把每个页面点一遍、重装扩展后全站回归、重复跑同一套手动清单。
>   这些只在用户明确要求（如发布前）时执行，并在报告中说明是用户要求的。
> - 「已验证」必须给出命令或操作事实；没验证就写「未验证」。

本仓库是 [cat-catch（猫抓）](https://github.com/xifangczy/cat-catch) 的二次开发分支
（GPL-3.0），产品代号 **Web Media Clipper**：在浏览器内注入悬浮媒体控制器，选完整视频或
多段时间区间，提交下载任务并统一管理。派生关系、许可义务、品牌隔离清单见 `NOTICE.md`。

## 先读

| 文件 | 何时读 | 位置 |
|---|---|---|
| `NOTICE.md` | 涉及许可、上游同步、品牌、依赖上游代码时 | 本仓库 |
| `~/wmc-dev/CONTEXT.md` | **每个新任务开始时**：当前迭代目标、已定决策、状态 | 私有 |
| `~/wmc-dev/docs/cat-catch-structure.md` | 需要导航上游代码时 | 私有 |
| `~/wmc-dev/docs/agents/development-workflow.md` | 做规划、写 SPEC、拆工单、修复收尾时 | 私有 |
| `~/wmc-dev/docs/agents/orca-orchestration.md` + `orca-recovery.md` | **仅在 Orca 内**（`ORCA_WORKTREE_ID` 或 `ORCA_TAB_ID` 已设）派发或执行时 | 私有 |
| `~/wmc-dev/docs/agents/documentation-conventions.md` | 新建/修改文档、维护 SPEC 时 | 私有 |
| `~/wmc-dev/docs/agents/issue-tracker.md` | 读写工单、标签、难度与归属时 | 私有 |
| `~/wmc-dev/spec/` | 需求池与 SPEC 正文 | 私有 |

规则细则在私有仓库，是**按需读**：只有触发对应流程时才读，不要在每次任务里全量加载。
本文件与私有规则冲突时，以本文件为准（它是每次都会读到的那一份）。

私有规则是 `y-agent-toolkit/agent-playbook` 的**适配版**，不是逐字拷贝：同步由 agent 读两边、
产出适配版并写 `~/wmc-dev/docs/agents/SYNC.md`（保留 / 改写 / 删除 / 例外 + 不变式自检，
含已同步的 playbook 版本）。本仓库专有的规则只写在本文件，不写进适配版。

## 铁律

1. **不改上游核心文件**：`js/m3u8.js`、`js/downloader.js`、`js/m3u8.downloader.js`、
   `js/popup.js`、`js/background.js`、`catch-script/*`、`lib/*`、`img/*`。需要扩展行为就
   在 `wmc/` 里包装。
2. **允许接线的上游文件只有三个**：`manifest*.json`、`js/init.js`（`G.scriptList`）、
   `popup.html`（按钮）。每处改动加 `// [WMC]` 注释，并把实质修改登记到 `NOTICE.md` §4。
3. **新功能代码一律进 `wmc/`**。新增目录后必须同步 `justfile` 的 `prepare`（`cp -r` 两行），
   否则打包缺文件——这是本项目唯一会静默损坏发布产物的坑。
4. **i18n**：扩展页用 `chrome.i18n` + `_locales/*/messages.json`。不要用 `catch-script/*`
   里 MAIN world 的 `window.CatCatchI18n`（那是给注入脚本的 workaround）。
5. **没有构建、没有模块系统**：页面按 `polyfill → init → function → templates → 业务`
   顺序加载 `<script>`，全局 `G`（`js/init.js`）共享配置。不要引入 ESM 或打包器。
6. `manifest.json` 的 `version` 只能是 1–4 段数字（如 `2.7.4.1`），带后缀会直接加载失败。

## 工作流与授权

- 只实现用户明确要求的范围。文档评审、工单就绪、任务分配**都不构成**实施授权。
- 新功能以 SPEC 为完整约定（`grill-with-docs → to-spec → to-tickets → implement /
  implement-spec → code-review`）。小改动用任务 + 验证即可，不为流程完整造文档。
- **SPEC 一旦 `Accepted` 即冻结**：不得为新增需求、迎合实现或记录进度改写。开发中发现
  不一致必须交回用户，裁定后加推翻标注，不得自行推翻。
- 推送、合并、发布、安装到用户浏览器、创建/修改远端，各自需要明确授权。
- 保留工作区里与本任务无关的改动。只暂存本任务的文件。

## 执行策略

- 优先最简单的可靠工具路径；只有独立操作才并行，有依赖或外部可见的变更串行执行。
- 需要并行、聚合、过滤大输出或多步编排时用 codemode；单一工具操作直接用工具。
- GitHub 相关一律优先 `gh`（issues / PR / release / `gh api`）。
- 改源码时优先 LSP 语义工具（定义、引用、符号、诊断），不要只靠文本搜索；改完查诊断。
- **在 Orca 内**：先读 `~/wmc-dev/docs/agents/orca-orchestration.md` 判定角色。被派发的
  worker 只按任务卡行动且**从不写工单**；协调者负责监督循环与工单；其他会话不发生命周期
  消息。Orca 里的位置不授予任何授权。

## 验证与 Git

- 改完只跑受影响那条路径的验证；失败先分类再修；保留未完成的验证为显式「未验证」。
- 提交用 Conventional Commit，只暂存本任务文件。**未经授权不得** push / merge /
  改写历史 / 发布 / 改远端。
- AI 提交的 Author 名要体现实际 harness（如 `Pi Agent`、`Claude Agent`、`Codex Agent`），
  用 `GIT_AUTHOR_NAME` 做执行级覆盖，不要改动仓库配置里的 email 与 Committer。
- 每个提交带 trailers，未知写 `unknown`，不要编：

  ```text
  AI-Model: <实际模型或 unknown>
  AI-Harness: <实际 harness 或 unknown>
  AI-Agent-Role: <当前角色或任务>
  AI-Task: <当前任务标题>
  AI-Session: <稳定会话 id 或 unknown>
  ```

## 任务收尾

**高优先级 —— 必需**：任何改动了文件、跑了命令或结束任务的回复，都以这四行收尾。
普通 Markdown，左对齐，粗体标签，一层列表（`-` 项；下一步用数字），回复本身不加代码围栏、
不加缩进。

- **状态**：做完了什么，≤2 行
- **证据**：`<命令>` → 观察到的结果；未验证：没检查的部分，或「无」
- **工单**：每条工单动作一行，`<工单引用> · <动作> · 已写 | 待授权 | 仅建议`
  （没有工单动作时省略此节。`已写` 指写入后读回确认；未授权的写标记 `待授权`；你只是
  提议而不自己做的事标 `仅建议`）
- **下一步**：2–3 个选项，每个用数字列表，`N. [<类型>] <选项> — <理由>`，恰好一项以
  `★ 推荐` 开头。类型取 `[实施]` `[验证]` `[调查]` `[决策]` `[收尾]`；需要授权的选项
  结尾标 `（需授权）`。无事可做时写 `下一步：无需后续`。

- **证据** 要写命令与观察到的结果，不能只写退出码。
- 在 Orca 内，`worker_done` 承载同一份收尾块，协调者用它写用户报告。

## 品牌与发布

- 「猫抓」「cat-catch」名称、上游图标、`*.94cat.com` 地址均不得用于指代本分支
  （GPL §7e 不授予商标权）。新增面向用户的文案保持中立。
- 上游同步：`git fetch upstream`（远端 `upstream` = `xifangczy/cat-catch`，只读，push 已禁用；
  新 clone 需 `git remote add upstream https://github.com/xifangczy/cat-catch.git`）后在自己的分支上 merge/rebase，不要把工作分支建在
  upstream 上。改动越集中在 `wmc/`，冲突越少。
