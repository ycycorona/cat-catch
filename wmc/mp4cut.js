// [WMC] MP4 Range 无损切段（SPEC-001 T5）。独立模块：不读猫抓的全局变量、不调用上游函数、
// 不设置请求头（请求头由面板的 DNR 层负责）。依赖：wmc/vendor/mp4box.all.min.js。
(function (global) {
    "use strict";

    var CONCURRENCY = 4;   // 最多 4 个并发 Range 请求
    var MERGE_GAP = 4096;  // 相邻样本之间的小空隙一起取，减少请求数

    function CutError(message) {
        var e = new Error(message);
        e.name = "CutError";
        return e;
    }

    function abortError() {
        return new DOMException("已取消", "AbortError");
    }

    function checkAbort(signal) {
        if (signal && signal.aborted) throw abortError();
    }

    // 取 [start, end]（含端点）字节。非 206 / 缺 Content-Range 都以可读错误 reject。
    async function getRange(url, start, end, signal) {
        checkAbort(signal);
        var res;
        try {
            res = await fetch(url, {
                headers: { Range: "bytes=" + start + "-" + end },
                credentials: "include",
                signal: signal,
            });
        } catch (err) {
            if (err && err.name === "AbortError") throw abortError();
            throw CutError("网络请求失败（bytes=" + start + "-" + end + "）：" + (err && err.message));
        }
        if (res.status !== 206) throw CutError("服务器未按 Range 响应（HTTP " + res.status + "），无法无损切段");
        var cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("Content-Range") || "");
        if (!cr) throw CutError("响应缺少有效的 Content-Range：" + res.headers.get("Content-Range"));
        if (Number(cr[1]) !== start) throw CutError("Content-Range 起点不符：期望 " + start + "，实际 " + cr[1]);
        var body;
        try {
            body = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            if (err && err.name === "AbortError") throw abortError();
            throw CutError("读取响应体失败（bytes=" + start + "-" + end + "）：" + (err && err.message));
        }
        return { bytes: body, total: cr[3] === "*" ? null : Number(cr[3]) };
    }

    // 逐个读顶层 box 头，跳过 mdat，直到找到 moov（不猜文件布局，也不整段下载尾部）。
    async function findMoov(url, signal) {
        var off = 0;
        var total = null;
        var ftyp = null; // mp4box 的 getInfo 需要 ftyp，缺少时把开头的 ftyp 一起喂进去
        for (var guard = 0; guard < 64; guard++) {
            if (total !== null && off >= total) break;
            var head = await getRange(url, off, off + 15, signal);
            if (total === null) total = head.total;
            if (head.bytes.byteLength < 8) break;
            var dv = new DataView(head.bytes.buffer, head.bytes.byteOffset, head.bytes.byteLength);
            var size = dv.getUint32(0);
            var type = String.fromCharCode(head.bytes[4], head.bytes[5], head.bytes[6], head.bytes[7]);
            if (size === 1) {
                var big = await getRange(url, off + 8, off + 15, signal);
                var bdv = new DataView(big.bytes.buffer, big.bytes.byteOffset, big.bytes.byteLength);
                size = Number(bdv.getBigUint64(0));
            } else if (size === 0) {
                if (total === null) throw CutError("无法确定文件长度");
                size = total - off;
            }
            if (size < 8) throw CutError("顶层 box 尺寸异常（" + type + " @ " + off + "：" + size + "）");
            if (type === "moov") return { offset: off, size: size, total: total, ftyp: ftyp };
            if (off === 0 && type === "ftyp") ftyp = { size: size };
            off += size;
        }
        throw CutError("找不到 moov（不是可解析的 MP4，或文件已损坏）");
    }

    function parseMoov(bytes) {
        return new Promise(function (resolve, reject) {
            var file = global.MP4Box.createFile();
            file.onError = function (e) {
                reject(CutError("moov 解析失败：" + e));
            };
            file.onReady = function (info) {
                resolve({ file: file, info: info });
            };
            var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            ab.fileStart = 0;
            try {
                file.appendBuffer(ab);
            } catch (e) {
                reject(CutError("moov 解析失败：" + (e && e.message)));
            }
        });
    }

    // 视频：起点回退到「不晚于 start 的最近关键帧」，终点为最后一帧结束（cts < end）。
    // cts 有首帧偏移（B 帧），按首样本 cts 归零后才和播放器的时间轴对齐。
    function videoWindow(samples, timescale, start, end, offset) {
        var i0 = -1, best = -1, i1 = 0;
        for (var i = 0; i < samples.length; i++) {
            var t = (samples[i].cts - offset) / timescale;
            if (samples[i].is_sync && t <= start && samples[i].cts > best) {
                best = samples[i].cts;
                i0 = i;
            }
            if (t < end) i1 = i;
        }
        if (i0 < 0) for (var j = 0; j < samples.length && i0 < 0; j++) if (samples[j].is_sync) i0 = j;
        if (i0 < 0) return null;
        if (i1 < i0) i1 = i0;
        return { from: i0, to: i1 };
    }

    // 音频：与 [from, to) 有交集的样本。
    function audioWindow(samples, timescale, from, to, offset) {
        var first = -1, last = -1;
        for (var i = 0; i < samples.length; i++) {
            var a = (samples[i].cts - offset) / timescale;
            var b = a + samples[i].duration / timescale;
            if (b <= from || a >= to) continue;
            if (first < 0) first = i;
            last = i;
        }
        return first < 0 ? null : { from: first, to: last };
    }

    // 所需样本的字节区间：排序后把小空隙合并，得到尽量少的请求。
    function planRanges(samples) {
        var spans = samples
            .map(function (s) {
                return { start: s.offset, end: s.offset + s.size };
            })
            .sort(function (a, b) {
                return a.start - b.start;
            });
        var merged = [];
        spans.forEach(function (span) {
            var last = merged[merged.length - 1];
            if (last && span.start - last.end <= MERGE_GAP) last.end = Math.max(last.end, span.end);
            else merged.push({ start: span.start, end: span.end });
        });
        return merged;
    }

    async function fetchRanges(url, ranges, signal, onProgress) {
        var data = new Array(ranges.length);
        var next = 0, done = 0;
        async function worker() {
            for (;;) {
                checkAbort(signal);
                var i = next++;
                if (i >= ranges.length) return;
                var r = ranges[i];
                var got = await getRange(url, r.start, r.end - 1, signal);
                data[i] = got.bytes;
                done++;
                if (onProgress) onProgress(done / ranges.length);
            }
        }
        var pool = [];
        for (var n = 0; n < Math.min(CONCURRENCY, ranges.length); n++) pool.push(worker());
        await Promise.all(pool);
        return data;
    }

    function spanIndex(ranges, offset) {
        var lo = 0, hi = ranges.length - 1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (offset < ranges[mid].start) hi = mid - 1;
            else if (offset >= ranges[mid].end) lo = mid + 1;
            else return mid;
        }
        return -1;
    }

    // 重封装：新建 ISOFile，按源 track 的 stsd 子 box（avcC / esds 等）重建编码配置，
    // 逐样本写入并把每轨时间戳归零（首样本 cts = 0，即 actualStart）。
    // shortcut: 只取第一条视频轨、忽略 edit list（elst），时间轴靠首样本 cts 对齐；
    // 遇到多视频轨或依赖 elst 的源再升级。输出是 fragmented MP4，每样本一个 moof。
    function remux(tracks) {
        var out = global.MP4Box.createFile();
        tracks.forEach(function (track) {
            var kind = track.info.type;
            if ((kind !== "video" && kind !== "audio") || !track.keep.length) return;
            var type = String(track.info.codec || "").split(".")[0];
            var opts = {
                timescale: track.info.timescale,
                language: track.info.language,
                type: type,
                id: track.info.id,
            };
            if (kind === "video") {
                opts.width = track.info.video.width;
                opts.height = track.info.video.height;
            } else {
                opts.hdlr = "soun";
                opts.samplerate = track.info.audio.sample_rate;
                opts.channel_count = track.info.audio.channel_count;
            }
            var newId = out.addTrack(opts);
            if (!newId) throw CutError("无法重建轨道（codec " + track.info.codec + "）");
            var entry = track.file.getTrackById(track.info.id).mdia.minf.stbl.stsd.entries[0];
            var dst = out.getTrackById(newId).mdia.minf.stbl.stsd.entries[0];
            (entry.boxes || []).forEach(function (box) {
                dst.addBox(box);
            });
            var base = track.keep[0].cts;
            track.keep.forEach(function (s) {
                out.addSample(newId, track.read(s), {
                    duration: s.duration,
                    cts: s.cts - base,
                    dts: s.dts - base,
                    is_sync: s.is_sync,
                    timescale: track.info.timescale,
                    description_index: 0,
                });
            });
        });
        return out.getBuffer();
    }

    async function cut(options) {
        var url = options && options.url;
        var start = options && options.start;
        var end = options && options.end;
        var signal = options && options.signal;
        var onProgress = options && options.onProgress;
        if (typeof url !== "string" || !url) throw CutError("缺少 url");
        if (!(start >= 0) || !(end > start)) throw CutError("区间无效：" + start + " ~ " + end);
        if (!global.MP4Box) throw CutError("缺少 mp4box（wmc/vendor/mp4box.all.min.js 未加载）");

        var moov = await findMoov(url, signal);
        if (moov.total !== null && moov.offset + moov.size > moov.total) throw CutError("moov 越界，文件可能被截断");
        var moovBytes = (await getRange(url, moov.offset, moov.offset + moov.size - 1, signal)).bytes;
        var brand = moov.ftyp
            ? (await getRange(url, 0, moov.ftyp.size - 1, signal)).bytes
            : new Uint8Array(0);
        var joined = new Uint8Array(brand.byteLength + moovBytes.byteLength);
        joined.set(brand, 0);
        joined.set(moovBytes, brand.byteLength);
        var parsed = await parseMoov(joined);
        var info = parsed.info;
        var file = parsed.file;

        var video = info.tracks.filter(function (t) {
            return t.type === "video";
        })[0];
        if (!video) throw CutError("文件里没有视频轨");
        var vSamples = file.getTrackSamplesInfo(video.id) || [];
        var vOffset = vSamples.length ? vSamples[0].cts : 0;
        var vWin = videoWindow(vSamples, video.timescale, start, end, vOffset);
        if (!vWin) throw CutError("找不到可用的关键帧");
        var actualStart = (vSamples[vWin.from].cts - vOffset) / video.timescale;
        var lastVideo = vSamples[vWin.to];
        var actualEnd = (lastVideo.cts + lastVideo.duration - vOffset) / video.timescale;

        var tracks = [{ info: video, file: file, keep: vSamples.slice(vWin.from, vWin.to + 1) }];
        info.tracks.forEach(function (t) {
            if (t.type !== "audio") return;
            var samples = file.getTrackSamplesInfo(t.id) || [];
            var win = audioWindow(samples, t.timescale, actualStart, actualEnd, samples.length ? samples[0].cts : 0);
            if (win) tracks.push({ info: t, file: file, keep: samples.slice(win.from, win.to + 1) });
        });

        var allSamples = [];
        tracks.forEach(function (t) {
            allSamples = allSamples.concat(t.keep);
        });
        var ranges = planRanges(allSamples);
        var fetched = await fetchRanges(url, ranges, signal, onProgress);

        tracks.forEach(function (t) {
            t.read = function (s) {
                var i = spanIndex(ranges, s.offset);
                if (i < 0) throw CutError("样本字节缺失（offset " + s.offset + "）");
                return fetched[i].subarray(s.offset - ranges[i].start, s.offset - ranges[i].start + s.size);
            };
        });
        checkAbort(signal);

        var buffer = remux(tracks);
        return { blob: new Blob([buffer], { type: "video/mp4" }), actualStart: actualStart, actualEnd: actualEnd };
    }

    global.WmcMp4Cut = { cut: cut };
})(typeof self !== "undefined" ? self : this);
