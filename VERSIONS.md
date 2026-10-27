# 版本号与上游关系

本分支自 `0.0.1` 起独立编号，不再沿用上游 cat-catch 的版本序列。`manifest.json` /
`manifest.firefox.json` 的 `version` 是本分支版本；与上游的对应关系只记录在这里。

## 版本关系表

| 本分支版本 | 日期 | 基于上游 | 上游提交 | 说明 |
|---|---|---|---|---|
| `0.0.1` | 2026-10-27 | cat-catch `2.7.4` | `97f6005` | 首个独立版本。SPEC-001 闭环（悬浮控制器、MP4/HLS 点播切段、任务面板、整段下载交接）；本地 `dev` 集成点 `8799834`。基础工作树提交 `8cec17f`（品牌隔离 + 骨架接线）。 |

## 规则

1. 本分支版本只写 `manifest*.json` 的 `version`，格式 1–4 段数字（`0.0.1`、`0.1.0`、`1.0.0`），不带后缀，否则扩展直接加载失败。
2. 每次同步上游（`git fetch upstream` 后 merge/rebase），在版本关系表**新增一行**：新版本号、日期、基于的上游版本与提交。不要改历史行。
3. 上游版本号不得写进 `manifest*.json`；品牌隔离要求见 `NOTICE.md` §5。
4. 发布物文件名取本分支版本（`justfile` 的 `build-zip` / `build-crx`）。

## 发布前闸门

这些是**必须实际执行并留下输出**的检查，不是清单勾选：

1. `just prepare` → `just build-zip` → `just build-crx` 三条命令完整跑通，产物名形如 `web-media-clipper<version>.zip/.crx`。
   - 为什么单列：`prepare` 曾因 `cp -r ./*.{js,html}` 在无根级 `.js` 的仓库上 exit 1，导致所有文档构建命令长期不可用而无人察觉（2026-10-27 修，提交 `f5e7c97`）。
2. 从未打包目录与打包目录各加载一次，跑一轮真实路径（至少：单段切段、整段下载）。
3. 签名包安装验证（`ExtensionInstallForcelist` + 本地 `update.xml`，需要 Chrome 策略目录可写）。
4. 真实站点、EME/DRM、Firefox 打包按 `SPEC-001` 的要求单独记录结果，未做就写「未验证」。
