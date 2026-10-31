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
| 2026-10-27 | 未发版 | 修「无法确定媒体源」判定：`wmc/overlay.js` 对「没找到播放列表」这一临时结论按 3 秒间隔、最多 12 次重试（直播/加密/无 Range 等定论不重试），避免 HLS 播放列表晚嗅探时永久置灰；`wmc/sw.js` 增加 DASH（`.mpd`）候选识别，只有 DASH 时回落为「暂不支持」而非「无法确定」 |
| 2026-10-27 | 未发版 | 品牌隔离扩展：`install.html`、`js/install.js` 的安装欢迎页文案与上游反馈链接改中性/指向本仓库 issue；`options.html` 的 11 处 `cat-catch.94cat.com` 文档链接、2 处上游 GitHub 链接改为本仓库，MQTT 默认占位值 `cat-catch-client`/`cat-catch/media` 改为 `web-media-clipper-*`；`_locales/{zh_CN,en}` 的 6 个含上游产品名的标题条目改中性。`AGENTS.md` 铁律 2 的品牌例外随之写明这三个文件只许改品牌字符串与上游链接 |
| 2026-10-27 | 未发版 | 版本号独立：`manifest.json`、`manifest.firefox.json` 的 `version` 由上游 `2.7.4` 改为本分支 `0.0.1`；新增 `VERSIONS.md` 记录本分支版本与上游版本/提交的对应关系及发布前闸门 |
| 2026-10-27 | 未发版 | 修 `justfile` 的 `prepare`：根目录没有 `*.js` 时 `cp -r ./*.{js,html} build/` 会以 exit 1 中止整个构建，改为 `find` 逐文件复制，`prepare` / `build-zip` / `build-crx` 才能按文档跑通 |
| 2026-10-28 | 未发版 | 媒体源判定修复：`wmc/hlscut.js` 返回 master 声明的变体关系，`wmc/sw.js` 按同源变体归组并保留独立来源歧义；无 MPD 的 Bilibili DASH 通过当前 frame 的播放器数据确认后显示既有不支持文案；`wmc/overlay.js` 换源清理未提交选段、重新判定并忽略旧响应，判定期间禁用添加选段 |
| 2026-10-28 | 未发版 | 简洁视图新增原生媒体名称选择框；手动选择固定控制对象，关闭改为隐藏并支持保留同源选段复开；`popup.html` 仅新增「打开分段浮窗」按钮及 `wmc/popup.js` 接线（`[WMC]` 标记），`_locales/{zh_CN,en}` 仅新增 `wmc_` 名称、切换确认与失败提示文案 |
| 2026-10-28 | 未发版 | 浮窗默认改为手动打开；`popup.html` 仅新增「自动显示浮窗」勾选框，`wmc/popup.js` / `wmc/overlay.js` 使用独立的本机设置 `wmcAutoShow`，默认关闭；`_locales/{zh_CN,en}` 只新增 `wmc_` 设置及失败提示文案 |
| 2026-10-28 | 未发版 | 浮窗新增简洁/标准视图切换、毫秒时间输入、多选段列表和八方向边缘拉伸；共享选段状态，时间显示补零并固定宽度，非法输入阻止下载；`wmc/sw.js` 校验多选段索引，任务面板沿用蓝/橙/绿段色；`_locales/{zh_CN,en}` 仅新增 `wmc_` 文案 |
| 2026-10-28 | 未发版 | 整段下载打开上游 `m3u8.html` 时追加 `wmc/m3u8-open.js`：仅当地址带 `wmcMp4=1` 才勾选 MP4 并取消 ffmpeg 转码。手动点放大镜不带该参数，解析页默认不变 |
| 2026-10-29 | 未发版 | 标准与工作室视图的「全览」左侧增加 5 min / 15 min / 30 min 细节窗口按钮；`_locales/*` 仅新增 `wmc_spanWindow` |
| 2026-10-29 | 未发版 | 浮窗 I / O 打入点、出点：只在浮窗有焦点或工作室模式时生效；`_locales/*` 仅新增 `wmc_keyMarkIn` / `wmc_keyMarkOut` |
| 2026-10-29 | 未发版 | 细节轴雪碧图预览：`manifest.json` 的 content script 列表追加 `wmc/sprites.js`（`document_start`）。预览逻辑在 `wmc/sprites.js`、`wmc/overlay.js`、`wmc/sw.js`、`wmc/hlscut.js` |
| 2026-10-30 | 未发版 | 雪碧图地址改从页面主世界读取：`manifest.json` 追加 `wmc/sprite-page.js`（`world: MAIN`，`document_start`）。播放器 `thumbnail` 配置和它时间轴上的图片地址写入 `video.dataset.wmcThumb`，浮窗只消费这份结果 |
| 2026-10-30 | 未发版 | B 站细节轴雪碧图：`wmc/sprite-page.js` 按当前播放器的 aid/cid 读取 videoshot 网格与时间索引；`wmc/sprites.js` 支持不等间隔的格子时间，换源时清除旧绑定。沿用标准视图预览交互，不增加 DASH 选段下载能力 |
| 2026-10-30 | 未发版 | 停靠浮窗贴在播放窗下沿。视口放不下时向下滚动页面把播放窗上移，上沿碰到视口顶就停；标准视图因此尽量露出，播放窗上沿仍留在画面里。`wmc/overlay.js` |
| 2026-10-30 | 未发版 | 细节轴点击或拖到窗口右侧不再带动总览窗口翻页。总览只在播放头从窗口内走进右侧十分之一时跟着移。`wmc/overlay.js` |
| 2026-10-30 | 未发版 | `wmc/popup.js`：分段浮窗打开成功后关闭猫抓弹窗。勾选自动显示、或打开失败时弹窗保持 |
| 2026-10-29 | 未发版 | `wmc/overlay.js` 的总览/细节轴播放头统一居中、冰蓝色短肩指针；轨道顶部预留 7px，三角尖端贴住轨道上沿，保留选段裁切和拖动区域 |
| 2026-10-30 | 未发版 | 分段记录按完整页面地址保存：同一地址最近 5 条，当前浏览器配置一共最近 200 条，多出来的从最旧的删起。恢复列表只显示当前地址。`wmc/sessions.js`、`wmc/overlay.js`；`_locales/*` 的 `wmc_sessionEmpty` 改为这个页面 |
| 2026-10-30 | 未发版 | 恢复列表里的片名过长时从中间省略，悬停用现有气泡显示全名。时间和段数不截。`wmc/overlay.js` |
| 2026-10-30 | 未发版 | 标准视图底栏左侧用「任务」打开任务面板，和右侧下载按钮分开：竖线、名单图标、冰蓝色字，没有描边框。`wmc/overlay.js`；`_locales/{zh_CN,en}` 的 `wmc_tasks` 是名词 |
| 2026-10-30 | 未发版 | 任务面板增加状态页签、搜索和标签页标题；进度更新只改已有行，不整表重建。`wmc/panel.html`、`wmc/panel.js`；`_locales/{zh_CN,en}` 新增 `wmc_tab*`、`wmc_search`、`wmc_searchClear`、`wmc_noMatch` |
| 2026-10-30 | 未发版 | 任务面板默认按站点再按媒体分组，可改为按页面或不分组，组可折叠。组头有完成比例，并能取消未完成、重试失败、清除已完成。`wmc/panel.html`、`wmc/panel.js`；`_locales/{zh_CN,en}` 新增 `wmc_group*`、`wmc_cancelOpen`、`wmc_retryFailed`、`wmc_clearDone`、`wmc_openSource`、`wmc_fold` |
| 2026-10-30 | 未发版 | 下载中的行显示进度条、已用时间和预计剩余；排队显示位次。完成后记下下载编号，可打开文件或在文件夹中显示，文件不在则置灰。失败、中断、已取消可删除记录，不删文件。`wmc/panel.js`、`wmc/panel.html`；`_locales/{zh_CN,en}` 新增 `wmc_queuePos`、`wmc_elapsed`、`wmc_eta`、`wmc_openFile`、`wmc_showFile`、`wmc_fileGone`、`wmc_delete`、`wmc_panelNote` |
| 2026-10-30 | 未发版 | 分段会话：`manifest.json` 的内容脚本在 `wmc/overlay.js` 前加入 `wmc/sessions.js`。每个网站在本机保留最近 10 条分段记录；再次打开默认是空的新会话。恢复和新会话只在工作室模式、添加选段那一行出现。简洁和标准模式同样自动保存，不显示入口。`_locales/*` 仅新增 `wmc_session*` |
| 2026-10-30 | 未发版 | HLS fMP4 选段封装修复：`wmc/hlscut.js` 清除初始化段中沿用的原片影片时长、轨道时长及可选片段总时长，让播放器按所选分片识别实际长度；音视频数据和相对偏移不变 |
| 2026-10-31 | 未发版 | 停靠浮窗跟随播放窗：页面或滚动容器滚动、播放窗改尺寸时重新贴在下沿；播放窗整个滚出视口时贴视口底边。不再为放下浮窗而滚动页面。拖动或拉伸过的浮窗不跟随。`wmc/overlay.js` |
| — | 0.1.0 | （待填）新增选段与任务模块 |

## 5. 品牌隔离清单（fork 后必须替换）

| 位置 | 现状 |
|---|---|
| `manifest.json` / `manifest.firefox.json` `name` | `__MSG_catCatch__` → 改 `_locales/*/messages.json` 的 `catCatch` 键 |
| 同上 `homepage_url`、`action.default_title` | ✅ 2026-10-27（`default_title` 随 `catCatch` 键生效） |
| `_locales/*/messages.json` | `catCatch`、`description` 共 11 种语言 —— ✅ 2026-10-27 |
| `popup.html:6` | ✅ 无需改：`<title>catCatch</title>` 是 i18n 键（`js/i18n.js:14`），随 `catCatch` 键显示新名 |
| `options.html` 文档/仓库链接 | ✅ 2026-10-27 改指本仓库（上游文档站无本分支内容） |
| `options.html` MQTT 默认 clientId / topic | ✅ 2026-10-27 改为 `web-media-clipper-client` / `web-media-clipper/media` |
| `img/icon.png`、`img/icon128.png`、`img/icon-disable.png` | ✅ 2026-10-27 中性占位（正式图标待定） |
| `img/cat-down*.png` 等按钮图标 | 上游图标，待评估 |
| `js/options.js:326` | 导出文件名前缀仍是 `cat-catch-<version>-…`（上游文件，属禁改区，仅记录） |
| `js/init.js` | 在线服务地址（`ffmpeg.94cat.com`、StreamSaver mitm 等）——自建或改为可配置；默认走 `bmmmd.com`（中性域名，功能依赖，暂留） |
| `install.html`、`js/install.js` 安装欢迎页 | ✅ 2026-10-27 品牌文案改中性、反馈链接指本仓库 |
| `_locales/*` 标题类条目 | ✅ 2026-10-27 `titleOption`/`titleDownload`/`titleM3U8`/`titleJson`/`titledash`/`alwaysDisableCatCatcher` 改中性 |
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
