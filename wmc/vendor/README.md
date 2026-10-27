# wmc/vendor — 第三方依赖（Web Media Clipper 私有增量）

本目录只放 WMC 自己的第三方运行时依赖，不属于上游 cat-catch 代码。
每个依赖在此登记版本、来源、校验值与许可；上游文件的修改记录见根 `NOTICE.md`。

## mp4box.all.min.js

| 项 | 值 |
|---|---|
| 包 / 版本 | `mp4box@0.5.3`（npm `dist-tags.latest` 为 2.5.0，但 2.x 只发布 cjs/mjs，没有可用的经典脚本全局 `MP4Box`，故固定 0.5.3） |
| 文件 | `dist/mp4box.all.min.js`（156 753 字节，构建标记 `/*! mp4box 02-11-2024 */`） |
| 下载地址 | https://registry.npmjs.org/mp4box/-/mp4box-0.5.3.tgz |
| tarball 完整性（npm `dist.integrity`） | `sha512-RIvyFZdPDIg3+mL6vUdPBSyQRrEfKO3ryAeJ4xJJV7HBHQUH3KfLlZRzfSpBHCd/HqR63HfbrWQI/CwXDvYENQ==` |
| 本文件 sha256 | `70221709a974a3ad6796935031c41565f3616cc4ed690c55dc59f97cd6d7dd1e` |
| 许可 | BSD-3-Clause，原文见同目录 `mp4box.LICENSE`（sha256 `ebad0332150a08f37389158289d93ab2f70b0ee8717d1db9b3d002febc6c5047`） |
| 上游 | https://github.com/gpac/mp4box.js （著作权：2012 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato） |

核实方式（2026-10-27 实测）：

```sh
curl -sL https://registry.npmjs.org/mp4box/-/mp4box-0.5.3.tgz -o /tmp/mp4box-0.5.3.tgz
tar xzf /tmp/mp4box-0.5.3.tgz -C /tmp && sha256sum /tmp/package/dist/mp4box.all.min.js
```

复用方式：经典 `<script>` 加载，顶层变量 `var MP4Box = { createFile }` 挂在全局；
用到的 API 只有 `createFile`、`appendBuffer`/`onReady`、`getTrackById`、
`getTrackSamplesInfo`、`addTrack`、`addSample`、`getBuffer`（0.5.3 实测可用）。
