# NOTICE — 二次开发与许可合规

本仓库是 [cat-catch（猫抓）](https://github.com/xifangczy/cat-catch) 的二次开发分支，
产品名暂定为 **Web Media Clipper**（日后可能更改；第 5 节的品牌替换先用这个名字执行）。

## 1. 上游归属

| 项 | 内容 |
|---|---|
| 原项目 | cat-catch（猫抓）资源嗅探扩展 |
| 原作者 | xifangczy 及 cat-catch 贡献者 |
| 上游地址 | https://github.com/xifangczy/cat-catch |
| 派生于 | commit `97f6005`，版本 2.7.4 |
| 原许可 | GNU General Public License v3.0（见 `LICENSE`） |

上游仓库的源码文件本身不带 `Copyright` / SPDX 头，版权归属以 `LICENSE` +
上游 README 的 License 段 + 上游 git 历史为准。本分支保留 `LICENSE` 原样不改。

## 2. 授权与义务

本分支整体以 **GPL-3.0** 分发，因此：

- ✅ 允许商业使用：收费、订阅、广告、赞助，收入全部归本分支维护者，无需向上游分成
- ✅ 允许修改、再分发
- ⚠️ 义务 1：向获得本扩展二进制（.crx / 商店包）的用户提供**完整对应源码**——本仓库公开即可满足
- ⚠️ 义务 2：保留原版权声明与许可文本，**显著标注已作修改**（§5a）→ 即本文件与第 4 节
- ⚠️ 义务 3：不得附加额外限制（§10）——不得写“禁止商用”“禁止再分发”“禁止改造成竞品”

上游 README 中「希望使用猫抓源码的扩展仍然保持开源」是作者意愿而非许可条款
（GPL §10 不允许附加限制），本分支选择遵守该意愿。

## 3. 不在 GPL 授权范围内的部分

- **商标 / 名称 / 图标**：GPL-3.0 §7e 明确不授予商标权。「猫抓」「cat-catch」名称、
  上游图标、`xifangczy` 身份、上游域名 `cat-catch.94cat.com` 均不得用于指代本分支，
  以免用户混淆为官方版本。本分支需替换为自有名称与图标（清单见第 5 节）。
- **上游用户文档与截图**：站外文档、README 配图版权归原作者，不随代码授权。

## 4. 修改记录

GPL §5a 要求标注修改。约定：**每个版本在此登记对上游文件的实质改动**；
新增文件（非上游存在）无需登记。

| 日期 | 版本 | 修改摘要 |
|---|---|---|
| 2026-10-27 | 未发版 | 品牌隔离：`_locales/*` 的 `catCatch` → Web Media Clipper、`description` 改中立描述；`manifest*.json` `homepage_url` 改本分支仓库；`img/icon.png`、`img/icon128.png`、`img/icon-disable.png` 原地换中性占位图标 |
| 2026-10-27 | 未发版 | 本机 agent 配置：`.gitignore` 排除 `.orca.local.yaml`；新增 `.worktreeinclude`，供 Orca 在新工作区复制本机偏好 |
| 2026-10-27 | 未发版 | Web Media Clipper 骨架接线：`manifest.json` 新增 `wmc/overlay.js` 内容脚本条目；`_locales/{zh_CN,en}` 新增 `wmc_panelTitle`；`js/init.js` 末尾新增一行导入 `/wmc/sw.js`（`// [WMC]` 标记）；`justfile` 的 `prepare` 追加复制 `wmc/` 与根 `manifest.json`（此前构建产物缺 `manifest.json`） |
| 2026-10-27 | 未发版 | 新增第三方依赖 `wmc/vendor/mp4box.all.min.js`（npm `mp4box@0.5.3`，BSD-3-Clause；来源、完整性与 sha256 见 `wmc/vendor/README.md`）与 `wmc/mp4cut.js`（MP4 Range 无损切段模块，不含上游代码） |
| 2026-10-27 | 未发版 | SPEC-001 T6：`wmc/sw.js` 由骨架扩为 `wmcResolve` / `wmcSubmit` 实现（仍只接管 `wmc` 前缀消息，上游监听器不变）；`_locales/{zh_CN,en}` 新增 `wmc_` 前缀的状态、按钮与离开确认文案（仅新增，未改既有条目）；`wmc/panel.js` 在新任务入队时唤醒串行执行队列，并用既有 i18n 文案填充面板标题 |
| 2026-10-27 | 未发版 | SPEC-001 T4：`wmc/overlay.js` 支持蓝橙两槽、边界调整与删除、最近播放绑定、任务徽标和页内关闭；`wmc/sw.js` 一次快照提交两段，MP4 整段下载交给右邻后台标签页（自动关闭），独立 `wmcHandoffs` 仅供面板中立提示；`wmc/panel.js` 展示交接提示且不混入下载任务状态；`_locales/{zh_CN,en}` 仅新增 `wmc_` 文案；受限验证探针在私有夹具 `harness-t4/`，不打包 |
| 2026-10-27 | 未发版 | SPEC-001 T3：新增 `wmc/hlscut.js`（HLS 点播切段，独立模块，不含上游代码）；`wmc/sw.js` 补 HLS 能力判定与四类不可选原因、HLS 整段下载交给上游 m3u8 解析页（后台标签 + 自动关闭）；`wmc/overlay.js` 不可选段时置灰「添加选段」并显示原因；`wmc/panel.js` 按 `kind` 分派切段模块；`_locales/{zh_CN,en}` 仅新增 `wmc_` 前缀的原因文案 |
| 2026-10-27 | 未发版 | 品牌隔离补漏：`justfile` 的 `build-zip` / `build-crx` 产物名由 `cat-catch${VERSION}.zip` / `.crx` 改为 `web-media-clipper${VERSION}.zip` / `.crx`（发布物文件名此前仍带上游品牌） |
| — | 0.1.0 | （待填）新增选段与任务模块 |

## 5. 品牌隔离清单（fork 后必须替换）

| 位置 | 现状 |
|---|---|
| `manifest.json` / `manifest.firefox.json` `name` | `__MSG_catCatch__` → 改 `_locales/*/messages.json` 的 `catCatch` 键 |
| 同上 `homepage_url`、`action.default_title` | ✅ 2026-10-27（`default_title` 随 `catCatch` 键生效） |
| `_locales/*/messages.json` | `catCatch`、`description` 共 11 种语言 —— ✅ 2026-10-27 |
| `popup.html:6` | ✅ 无需改：`<title>catCatch</title>` 是 i18n 键（`js/i18n.js:14`），随 `catCatch` 键显示新名 |
| `options.html:203-976` | 多处 `cat-catch.94cat.com` 文档链接、上游 GitHub 链接 |
| `options.html:890,914` | MQTT 默认 clientId / topic 含 `cat-catch` |
| `img/icon.png`、`img/icon128.png`、`img/icon-disable.png` | ✅ 2026-10-27 中性占位（正式图标待定） |
| `img/cat-down*.png` 等按钮图标 | 上游图标，待评估 |
| `js/init.js` | 在线服务地址（`ffmpeg.94cat.com`、StreamSaver mitm 等）——自建或改为可配置 |
| `README*.md`、`CHANGELOG.md`、`justfile` 注释与描述 | 上游项目名与描述（文件名与产物名已处理，见下一条） |
| `justfile` 发布产物名（`build-zip` / `build-crx`） | ✅ 2026-10-27：`cat-catch${VERSION}.zip` / `.crx` → `web-media-clipper${VERSION}.zip` / `.crx`，不再把上游品牌写进发布物 |

## 6. 上游同步约定

为了能持续 `git pull` 上游修复：

- **新增功能一律放在 `wmc/` 目录**，不改动上游核心文件（清单见 `AGENTS.md` 铁律 1）
- 允许接线的上游文件只有四处：`manifest*.json`、`js/init.js`、`popup.html`、
  `_locales/*/messages.json`，只新增条目（细则见 `AGENTS.md` 铁律 2）
- 改动集中、加 `// [WMC]` 标记，便于 `git diff upstream/master` 时筛出本地增量
- 上游分支保持只读：`git remote add upstream https://github.com/xifangczy/cat-catch && git fetch upstream`

## 7. 与本分支通信的其他程序

本扩展可以通过公开的接口协议（如 HTTP + JSON），与单独分发的程序通信，例如本地下载服务或
转录服务。这些程序是独立的作品：它们不包含本分支或上游的代码，不随本扩展分发，
不属于本分支，也不受本分支的 GPL-3.0 约束。本分支只负责扩展这一侧；接口协议的字段与语义
单独成文，以便任何一方独立实现。
