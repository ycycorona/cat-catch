# AGENTS.md

本仓库只记录**工程事实**。流程细则与完整验证纪律在每台机器本地的私有规则里，位置记在仓库根的
`.wmc.local.json` 的 `privateRules`（gitignored，不入库）；该文件不存在时只按本文件执行。
读到位置后先看其中的 `CONTEXT.md` 与 `docs/agents/agent-rules.md`。

## 铁律

1. 不改上游核心文件：`js/m3u8.js`、`js/downloader.js`、`js/m3u8.downloader.js`、`js/popup.js`、
   `js/background.js`、`catch-script/*`、`lib/*`、`img/*`。新功能一律放进 `wmc/`（品牌隔离的例外文件见
   `NOTICE.md` §5）。
2. 只允许接线四处上游文件：`manifest*.json`、`js/init.js`（`G.scriptList`）、`popup.html`、
   `_locales/*/messages.json`。只**新增**条目，`_locales` 新键带 `wmc_` 前缀，其余改动加 `// [WMC]`。
3. 新增目录后必须同步 `justfile` 的 `prepare`，否则打包缺文件。
4. i18n 走 `chrome.i18n` + `_locales/*/messages.json`，不用注入脚本里的 `window.CatCatchI18n`。
5. 没有构建、没有模块系统：`<script>` 按 `polyfill → init → function → templates → 业务` 顺序加载，
   全局 `G`（`js/init.js`）共享配置。不引入 ESM 或打包器。
6. `manifest.json` 的 `version` 只能是 1–4 段数字（如 `2.7.4.1`），带后缀会直接加载失败。

许可与派生关系见 `NOTICE.md` §1–§3，品牌隔离清单见 §5，上游同步约定见 §6。品牌名与上游图标
不得用于指代本分支（GPL §7e 不授予商标权）。

## 验证

本项目没有自动化测试：验证＝加载扩展走一遍受影响的那条路径。

- 每条浏览器命令都带 `--mute-audio`，并用独立 profile（`--user-data-dir=/tmp/wmc-<task>`）。
- 单次验证 ≤3 分钟，只验改动面。
- 「已验证」必须给出命令或操作事实；没验证就写「未验证」。

## 提交

Conventional Commit，只暂存本任务文件，保留工作区里与任务无关的改动。**未经授权不得**
push / merge / 改写历史 / 发布 / 改远端。AI 提交的 Author 名体现实际 harness，并用
`GIT_AUTHOR_NAME` 做执行级覆盖。
