// [WMC] 音视频分开的点播：按分片索引只取选中区间，再合成一个 MP4。
// 独立模块：不读猫抓的全局变量、不调用上游函数、不设置请求头（请求头由面板的 DNR 层负责）。
// 依赖：wmc/vendor/mp4box.all.min.js。
// 有 sidx（或播放器给的 indexRange）时只发 Range。没有分片索引但 moov 里有样本表时，
// 只取样本字节。两者都没有，才把这一条整段下下来再切。
(function (global) {
    "use strict";

    var CONCURRENCY = 4;

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

    function isAbort(err) {
        return err && (err.name === "AbortError" || err === abortError);
    }

    // 取 [start, end]（含端点）字节。
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
            if (isAbort(err)) throw abortError();
            throw CutError("网络请求失败（bytes=" + start + "-" + end + "）：" + (err && err.message));
        }
        if (res.status !== 206) throw CutError("服务器未按 Range 响应（HTTP " + res.status + "），无法按分片切段");
        var cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("Content-Range") || "");
        if (!cr) throw CutError("响应缺少有效的 Content-Range：" + res.headers.get("Content-Range"));
        if (Number(cr[1]) !== start) throw CutError("Content-Range 起点不符：期望 " + start + "，实际 " + cr[1]);
        var body;
        try {
            body = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            if (isAbort(err)) throw abortError();
            throw CutError("读取响应体失败（bytes=" + start + "-" + end + "）：" + (err && err.message));
        }
        if (body.byteLength < end - start + 1) throw CutError("响应字节不足（bytes=" + start + "-" + end + "）");
        return { bytes: body, total: cr[3] === "*" ? null : Number(cr[3]) };
    }

    async function getAll(url, signal, tick) {
        checkAbort(signal);
        var res;
        try {
            res = await fetch(url, { credentials: "include", signal: signal });
        } catch (err) {
            if (isAbort(err)) throw abortError();
            throw CutError("整段下载失败：" + (err && err.message));
        }
        if (!res.ok) throw CutError("整段下载失败（HTTP " + res.status + "）");
        var body;
        try {
            body = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            if (isAbort(err)) throw abortError();
            throw CutError("整段下载失败：" + (err && err.message));
        }
        if (tick) tick(body.byteLength);
        return body;
    }

    function fourcc(bytes, offset) {
        return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    }

    function viewOf(bytes) {
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    // "0-813" 这种闭区间。播放器 SegmentBase 用的就是这个写法。
    function parsePair(text) {
        var m = /^(\d+)-(\d+)$/.exec(String(text || ""));
        if (!m) return null;
        var start = Number(m[1]);
        var end = Number(m[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
        return { start: start, end: end + 1 };
    }

    function boxAt(bytes, offset) {
        if (offset + 8 > bytes.byteLength) return null;
        var view = viewOf(bytes);
        var size = view.getUint32(offset);
        var type = fourcc(bytes, offset + 4);
        var header = 8;
        if (size === 1) {
            if (offset + 16 > bytes.byteLength) return null;
            size = Number(view.getBigUint64(offset + 8));
            header = 16;
        }
        if (size < header) return null;
        return { type: type, size: size, header: header };
    }

    // sidx 在 fileOffset。返回的 start/size 是文件里的绝对字节。time 是这条分片自己的时间轴，秒。
    function parseSidx(bytes, fileOffset) {
        var box = boxAt(bytes, 0);
        if (!box || box.type !== "sidx") {
            for (var i = 4; i + 4 <= bytes.byteLength; i++) {
                if (fourcc(bytes, i) !== "sidx" || i < 4) continue;
                return parseSidx(bytes.subarray(i - 4), fileOffset + i - 4);
            }
            return null;
        }
        if (box.size > bytes.byteLength) return null;
        var view = viewOf(bytes);
        var version = bytes[8];
        var p = 12;
        p += 4;
        var timescale = view.getUint32(p);
        p += 4;
        if (!timescale) return null;
        var earliest;
        var firstOffset;
        if (version === 0) {
            earliest = view.getUint32(p);
            p += 4;
            firstOffset = view.getUint32(p);
            p += 4;
        } else {
            earliest = Number(view.getBigUint64(p));
            p += 8;
            firstOffset = Number(view.getBigUint64(p));
            p += 8;
        }
        p += 2;
        var count = view.getUint16(p);
        p += 2;
        if (p + count * 12 > box.size) return null;
        var time = earliest;
        var pos = fileOffset + box.size + firstOffset;
        var fragments = [];
        for (var n = 0; n < count; n++) {
            var word = view.getUint32(p);
            p += 4;
            var duration = view.getUint32(p);
            p += 4;
            var sapWord = view.getUint32(p);
            p += 4;
            if ((word >>> 31) === 1) return null;
            var size = word & 0x7fffffff;
            fragments.push({
                start: pos,
                size: size,
                time: time / timescale,
                duration: duration / timescale,
                sap: (sapWord >>> 31) === 1,
            });
            time += duration;
            pos += size;
        }
        return fragments.length ? fragments : null;
    }

    // 只读顶层 box 头，跳过 mdat。sidx 一般在第一段媒体前面。
    async function scanLayout(url, signal) {
        var off = 0;
        var total = null;
        var found = {};
        for (var guard = 0; guard < 64; guard++) {
            if (total !== null && off >= total) break;
            var end = total !== null ? Math.min(off + 15, total - 1) : off + 15;
            if (end < off + 7) break;
            var head = await getRange(url, off, end, signal);
            if (total === null) total = head.total;
            if (head.bytes.byteLength < 8) break;
            var view = viewOf(head.bytes);
            var size = view.getUint32(0);
            var type = fourcc(head.bytes, 4);
            if (size === 1) {
                var big = await getRange(url, off + 8, off + 15, signal);
                size = Number(viewOf(big.bytes).getBigUint64(0));
            } else if (size === 0) {
                if (total === null) throw CutError("无法确定文件长度");
                size = total - off;
            }
            if (size < 8) throw CutError("顶层 box 尺寸异常（" + type + " @ " + off + "：" + size + "）");
            if (type === "ftyp" || type === "moov" || type === "sidx") found[type] = { start: off, end: off + size };
            off += size;
            if (found.sidx && found.moov) break;
            if ((type === "moof" || type === "mdat") && !found.sidx) break;
        }
        found.total = total;
        return found;
    }

    function initRangeFrom(layout) {
        if (!layout.moov) return null;
        var start = layout.ftyp && layout.ftyp.start < layout.moov.start ? layout.ftyp.start : layout.moov.start;
        return { start: start, end: layout.moov.end };
    }

    async function openSide(url, initHint, indexHint, signal) {
        var hintedInit = parsePair(initHint);
        var hintedIndex = parsePair(indexHint);
        if (hintedInit && hintedIndex) {
            try {
                var hinted = await getRange(url, hintedIndex.start, hintedIndex.end - 1, signal);
                var hintedFragments = parseSidx(hinted.bytes, hintedIndex.start);
                if (hintedFragments) {
                    return {
                        kind: "sidx",
                        fragments: hintedFragments,
                        initRange: hintedInit,
                        origin: hintedFragments[0].time,
                    };
                }
            } catch (err) {
                if (isAbort(err)) throw err;
            }
        }
        var layout = null;
        try {
            layout = await scanLayout(url, signal);
        } catch (err) {
            if (isAbort(err)) throw err;
        }
        if (layout && layout.sidx) {
            var sidx = await getRange(url, layout.sidx.start, layout.sidx.end - 1, signal);
            var fragments = parseSidx(sidx.bytes, layout.sidx.start);
            var initRange = initRangeFrom(layout);
            if (fragments && initRange) {
                return { kind: "sidx", fragments: fragments, initRange: initRange, origin: fragments[0].time };
            }
        }
        if (layout && layout.moov) {
            var table = await readSampleTable(url, layout, signal);
            if (table) return table;
        }
        return { kind: "whole" };
    }

    function parseMoov(bytes) {
        return new Promise(function (resolve, reject) {
            if (!global.MP4Box) {
                reject(CutError("缺少 mp4box（wmc/vendor/mp4box.all.min.js 未加载）"));
                return;
            }
            var file = global.MP4Box.createFile();
            file.onError = function (e) { reject(CutError("moov 解析失败：" + e)); };
            file.onReady = function (info) { resolve({ file: file, info: info }); };
            var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            ab.fileStart = 0;
            try {
                file.appendBuffer(ab);
                file.flush();
            } catch (e) {
                reject(CutError("moov 解析失败：" + (e && e.message)));
            }
        });
    }

    async function readSampleTable(url, layout, signal) {
        var range = initRangeFrom(layout);
        if (!range) return null;
        var bytes = (await getRange(url, range.start, range.end - 1, signal)).bytes;
        var parsed;
        try {
            parsed = await parseMoov(bytes);
        } catch (err) {
            if (isAbort(err)) throw err;
            return null;
        }
        var tracks = parsed.info.tracks.filter(function (track) {
            return track.type === "video" || track.type === "audio";
        });
        if (!tracks.length) return null;
        var samples = [];
        tracks.forEach(function (track) {
            var list = parsed.file.getTrackSamplesInfo(track.id) || [];
            list.forEach(function (sample) { sample.timescale = track.timescale; });
            if (list.length) samples.push({ info: track, samples: list });
        });
        if (!samples.length) return null;
        var origin = samples[0].samples[0].cts / samples[0].info.timescale;
        return { kind: "table", file: parsed.file, tracks: samples, origin: origin };
    }

    function wantTrack(side, kind) {
        if (side.kind !== "table") return null;
        for (var i = 0; i < side.tracks.length; i++) {
            if (side.tracks[i].info.type === kind) return side.tracks[i];
        }
        return null;
    }

    // 播放器时间 0 对齐这条流第一片的时间。用户选的 start/end 是播放器时间。
    function playerTime(sample, origin) {
        return sample.cts / sample.timescale - origin;
    }

    function keepVideo(samples, start, end, origin) {
        var i0 = -1;
        var best = -1;
        var i1 = 0;
        for (var i = 0; i < samples.length; i++) {
            var t = playerTime(samples[i], origin);
            if (samples[i].is_sync && t <= start + 1e-3 && samples[i].cts >= best) {
                best = samples[i].cts;
                i0 = i;
            }
            if (t < end) i1 = i;
        }
        if (i0 < 0) {
            for (var j = 0; j < samples.length; j++) if (samples[j].is_sync) { i0 = j; break; }
        }
        if (i0 < 0) return null;
        if (i1 < i0) i1 = i0;
        return samples.slice(i0, i1 + 1);
    }

    function keepAudio(samples, from, to, origin) {
        var kept = [];
        for (var i = 0; i < samples.length; i++) {
            var a = playerTime(samples[i], origin);
            var b = a + samples[i].duration / samples[i].timescale;
            if (b <= from + 1e-3 || a >= to - 1e-3) continue;
            kept.push(samples[i]);
        }
        return kept;
    }

    function selectSap(fragments, start, end, origin) {
        var from = -1;
        for (var i = 0; i < fragments.length; i++) {
            var t = fragments[i].time - origin;
            if (fragments[i].sap && t <= start + 1e-3) from = i;
        }
        if (from < 0) {
            for (var j = 0; j < fragments.length; j++) if (fragments[j].sap) { from = j; break; }
        }
        if (from < 0) from = 0;
        var to = from;
        for (var n = from; n < fragments.length; n++) {
            if (fragments[n].time - origin < end - 1e-3) to = n;
            else break;
        }
        return fragments.slice(from, to + 1);
    }

    function selectOverlap(fragments, absStart, absEnd) {
        return fragments.filter(function (fragment) {
            return fragment.time < absEnd - 1e-3 && fragment.time + fragment.duration > absStart + 1e-3;
        });
    }

    function mergeSpans(spans) {
        var sorted = spans.slice().sort(function (a, b) { return a.start - b.start; });
        var merged = [];
        sorted.forEach(function (span) {
            var last = merged[merged.length - 1];
            if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
            else merged.push({ start: span.start, end: span.end });
        });
        return merged;
    }

    async function fetchSpans(url, spans, signal, tick) {
        var ranges = mergeSpans(spans);
        var parts = new Array(ranges.length);
        var next = 0;
        async function worker() {
            for (;;) {
                checkAbort(signal);
                var index = next++;
                if (index >= ranges.length) return;
                var range = ranges[index];
                var got = await getRange(url, range.start, range.end - 1, signal);
                parts[index] = got.bytes;
                if (tick) tick(got.bytes.byteLength);
            }
        }
        var workers = [];
        for (var n = 0; n < Math.min(CONCURRENCY, ranges.length); n++) workers.push(worker());
        await Promise.all(workers);
        var total = 0;
        parts.forEach(function (part) { total += part.byteLength; });
        var out = new Uint8Array(total);
        var offset = 0;
        parts.forEach(function (part) {
            out.set(part, offset);
            offset += part.byteLength;
        });
        return out;
    }

    // default-base-is-moof 的分片拼在一起就能解析。绝对偏移的，改成新缓冲区里的位置。
    function relocateFragment(bytes, delta) {
        if (!delta) return bytes;
        var needs = false;
        function walk(start, end) {
            var offset = start;
            while (offset + 8 <= end) {
                var box = boxAt(bytes, offset);
                if (!box || offset + box.size > end) break;
                if (box.type === "tfhd") {
                    var flags = (bytes[offset + box.header + 1] << 16) | (bytes[offset + box.header + 2] << 8) | bytes[offset + box.header + 3];
                    if (flags & 1) needs = true;
                } else if (box.type === "moof" || box.type === "traf") {
                    walk(offset + box.header, offset + box.size);
                }
                offset += box.size;
            }
        }
        walk(0, bytes.byteLength);
        if (!needs) return bytes;
        var out = bytes.slice();
        function patch(start, end) {
            var offset = start;
            while (offset + 8 <= end) {
                var box = boxAt(out, offset);
                if (!box || offset + box.size > end) break;
                if (box.type === "tfhd") {
                    var flags = (out[offset + box.header + 1] << 16) | (out[offset + box.header + 2] << 8) | out[offset + box.header + 3];
                    if (flags & 1) {
                        var at = offset + box.header + 4 + 4;
                        var base = viewOf(out).getBigUint64(at);
                        viewOf(out).setBigUint64(at, base + BigInt(delta));
                    }
                } else if (box.type === "moof" || box.type === "traf") {
                    patch(offset + box.header, offset + box.size);
                }
                offset += box.size;
            }
        }
        patch(0, out.byteLength);
        return out;
    }

    function concat(parts) {
        var total = 0;
        parts.forEach(function (part) { total += part.byteLength; });
        var out = new Uint8Array(total);
        var offset = 0;
        parts.forEach(function (part) {
            out.set(part, offset);
            offset += part.byteLength;
        });
        return out;
    }

    function extractBytes(bytes) {
        return new Promise(function (resolve, reject) {
            if (!global.MP4Box) {
                reject(CutError("缺少 mp4box（wmc/vendor/mp4box.all.min.js 未加载）"));
                return;
            }
            var file = global.MP4Box.createFile();
            var byId = new Map();
            var info = null;
            var failed = null;
            file.onError = function (e) { failed = e; };
            file.onReady = function (ready) {
                info = ready;
                ready.tracks.forEach(function (track) {
                    file.setExtractionOptions(track.id, null, { nbSamples: 1e7 });
                });
                file.start();
            };
            file.onSamples = function (id, user, list) {
                var got = byId.get(id);
                if (!got) byId.set(id, got = []);
                list.forEach(function (sample) { got.push(sample); });
            };
            try {
                var ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                    ? bytes.buffer
                    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                ab.fileStart = 0;
                file.appendBuffer(ab);
                file.flush();
            } catch (e) {
                reject(CutError("分片解析失败：" + ((e && e.message) || e)));
                return;
            }
            if (failed) reject(CutError("分片解析失败：" + failed));
            else if (!info) reject(CutError("文件里没有 moov"));
            else resolve({ file: file, info: info, byId: byId });
        });
    }

    function trackFromExtract(extracted, kind) {
        var info = null;
        for (var i = 0; i < extracted.info.tracks.length; i++) {
            if (extracted.info.tracks[i].type === kind) { info = extracted.info.tracks[i]; break; }
        }
        if (!info) throw CutError(kind === "video" ? "视频文件里没有视频轨" : "音频文件里没有音频轨");
        var samples = extracted.byId.get(info.id) || [];
        samples.forEach(function (sample) {
            if (!sample.timescale) sample.timescale = info.timescale;
        });
        if (!samples.length) throw CutError(kind === "video" ? "视频里没有样本" : "音频里没有样本");
        var origin = samples[0].cts / samples[0].timescale;
        return { info: info, file: extracted.file, samples: samples, origin: origin };
    }

    async function pullFragments(url, side, fragments, kind, signal, tick) {
        if (!fragments.length) throw CutError(kind === "video" ? "找不到覆盖选区的视频分片" : "找不到覆盖选区的音频分片");
        var initBytes = (await getRange(url, side.initRange.start, side.initRange.end - 1, signal)).bytes;
        if (tick) tick(initBytes.byteLength);
        var raw = new Array(fragments.length);
        var next = 0;
        async function worker() {
            for (;;) {
                checkAbort(signal);
                var index = next++;
                if (index >= fragments.length) return;
                var fragment = fragments[index];
                var got = await getRange(url, fragment.start, fragment.start + fragment.size - 1, signal);
                raw[index] = got.bytes;
                if (tick) tick(got.bytes.byteLength);
            }
        }
        var workers = [];
        for (var n = 0; n < Math.min(CONCURRENCY, fragments.length); n++) workers.push(worker());
        await Promise.all(workers);
        var placed = [];
        var cursor = initBytes.byteLength;
        for (var i = 0; i < fragments.length; i++) {
            var moved = relocateFragment(raw[i], cursor - fragments[i].start);
            placed.push(moved);
            cursor += moved.byteLength;
        }
        var extracted = await extractBytes(concat([initBytes].concat(placed)));
        var track = trackFromExtract(extracted, kind);
        // 时间原点用整条索引的第一片，不用这次取到的第一片。
        track.origin = side.origin;
        return track;
    }

    async function pullWhole(url, kind, signal, tick) {
        var bytes = await getAll(url, signal, tick);
        var extracted = await extractBytes(bytes);
        return trackFromExtract(extracted, kind);
    }

    async function fillSampleData(url, samples, signal, tick) {
        var spans = samples.map(function (sample) {
            return { start: sample.offset, end: sample.offset + sample.size };
        });
        var ranges = mergeSpans(spans);
        var parts = new Array(ranges.length);
        var next = 0;
        async function worker() {
            for (;;) {
                checkAbort(signal);
                var index = next++;
                if (index >= ranges.length) return;
                var range = ranges[index];
                var got = await getRange(url, range.start, range.end - 1, signal);
                parts[index] = { start: range.start, bytes: got.bytes };
                if (tick) tick(got.bytes.byteLength);
            }
        }
        var workers = [];
        for (var n = 0; n < Math.min(CONCURRENCY, ranges.length || 1); n++) workers.push(worker());
        await Promise.all(workers);
        samples.forEach(function (sample) {
            var part = null;
            for (var i = 0; i < parts.length; i++) {
                var candidate = parts[i];
                if (sample.offset >= candidate.start && sample.offset + sample.size <= candidate.start + candidate.bytes.byteLength) {
                    part = candidate;
                    break;
                }
            }
            if (!part) throw CutError("样本字节缺失（offset " + sample.offset + "）");
            sample.data = part.bytes.subarray(sample.offset - part.start, sample.offset - part.start + sample.size);
        });
    }

    // 两条流用同一个播放器时间作零点。mp4box 写片时减去该轨 first_dts，
    // cts 和 dts 一起加的延迟会被减掉；视频的 cts-dts 会留下，画面因此晚于声音。
    // 这版 trun 固定 version 0，负的合成偏移写不进去。用空编辑把音频首样本挪到和画面相同的呈现时间。
    function remux(video, audio, zeroAt) {
        var firstVideo = video.samples[0];
        var lead = 0;
        if (firstVideo && firstVideo.cts > firstVideo.dts) {
            lead = (firstVideo.cts - firstVideo.dts) / video.info.timescale;
        }
        var out = global.MP4Box.createFile();
        [video, audio].forEach(function (track) {
            var info = track.info;
            var type = String(info.codec || "").split(".")[0];
            var opts = {
                timescale: info.timescale,
                language: info.language || "und",
                type: type,
                id: info.type === "video" ? 1 : 2,
            };
            if (info.type === "video") {
                opts.width = info.video.width;
                opts.height = info.video.height;
            } else {
                opts.hdlr = "soun";
                opts.samplerate = info.audio.sample_rate;
                opts.channel_count = info.audio.channel_count;
            }
            var newId = out.addTrack(opts);
            if (!newId) throw CutError("无法重建轨道（codec " + info.codec + "）");
            var entry = track.file.getTrackById(info.id).mdia.minf.stbl.stsd.entries[0];
            var dst = out.getTrackById(newId).mdia.minf.stbl.stsd.entries[0];
            (entry.boxes || []).forEach(function (box) { dst.addBox(box); });
            var base = Math.round((track.origin + zeroAt) * info.timescale);
            track.samples.forEach(function (sample) {
                if (!sample.data) throw CutError("样本没有数据");
                out.addSample(newId, sample.data, {
                    duration: sample.duration,
                    cts: sample.cts - base,
                    dts: sample.dts - base,
                    is_sync: sample.is_sync,
                    timescale: info.timescale,
                    description_index: 0,
                });
            });
        });
        var firstAudio = audio.samples[0];
        if (firstAudio && lead > 0) {
            var mediaPts0 = (firstAudio.cts - firstAudio.dts) / audio.info.timescale;
            var desired = firstAudio.cts / audio.info.timescale - audio.origin - zeroAt + lead;
            var movieScale = out.moov.mvhd.timescale || 600;
            var empty = Math.round((desired - mediaPts0) * movieScale);
            // shortcut: 音频早于画面、且早过编码延迟时，空编辑没法把起点放到 0 之前。
            if (empty > 0) {
                var mediaDur = 0;
                audio.samples.forEach(function (sample) { mediaDur += sample.duration; });
                var span = Math.ceil(mediaDur * movieScale / audio.info.timescale);
                var elst = out.getTrackById(2).add("edts").add("elst");
                elst.entries = [
                    { segment_duration: empty, media_time: -1, media_rate_integer: 1, media_rate_fraction: 0 },
                    { segment_duration: Math.max(span, 1), media_time: 0, media_rate_integer: 1, media_rate_fraction: 0 },
                ];
            }
        }
        return out.getBuffer();
    }

    async function cut(options) {
        var videoUrl = options && options.videoUrl;
        var audioUrl = options && options.audioUrl;
        var start = Number(options && options.start);
        var end = Number(options && options.end);
        var signal = options && options.signal;
        var onProgress = options && options.onProgress;
        if (!videoUrl || !audioUrl) throw CutError("缺少视频或音频地址");
        if (!(end > start) || start < 0) throw CutError("区间无效：" + start + " ~ " + end);
        if (!global.MP4Box) throw CutError("缺少 mp4box（wmc/vendor/mp4box.all.min.js 未加载）");

        var done = 0;
        var planned = 0;
        function tick(n) {
            done += n;
            if (onProgress && planned) onProgress(Math.min(0.99, done / planned));
        }

        var videoSide = await openSide(videoUrl, options.videoInit, options.videoIndex, signal);
        var audioSide = await openSide(audioUrl, options.audioInit, options.audioIndex, signal);
        checkAbort(signal);

        var videoPack;
        var videoOrigin;
        if (videoSide.kind === "sidx") {
            var videoFragments = selectSap(videoSide.fragments, start, end, videoSide.origin);
            planned += (videoSide.initRange.end - videoSide.initRange.start);
            videoFragments.forEach(function (fragment) { planned += fragment.size; });
            videoPack = await pullFragments(videoUrl, videoSide, videoFragments, "video", signal, tick);
            videoOrigin = videoSide.origin;
        } else if (videoSide.kind === "table") {
            var videoTrack = wantTrack(videoSide, "video");
            if (!videoTrack) throw CutError("视频文件里没有视频轨");
            videoPack = { info: videoTrack.info, file: videoSide.file, samples: videoTrack.samples, origin: videoSide.origin };
            videoOrigin = videoSide.origin;
        } else {
            videoPack = await pullWhole(videoUrl, "video", signal, tick);
            videoOrigin = videoPack.origin;
        }

        var videoKept = keepVideo(videoPack.samples, start, end, videoOrigin);
        if (!videoKept) throw CutError("找不到可用的关键帧");
        if (videoSide.kind === "table") {
            videoKept.forEach(function (sample) { planned += sample.size; });
            await fillSampleData(videoUrl, videoKept, signal, tick);
        }
        var actualStart = playerTime(videoKept[0], videoOrigin);
        var lastVideo = videoKept[videoKept.length - 1];
        var actualEnd = playerTime(lastVideo, videoOrigin) + lastVideo.duration / lastVideo.timescale;

        var audioPack;
        var audioOrigin;
        if (audioSide.kind === "sidx") {
            var audioFragments = selectOverlap(
                audioSide.fragments,
                audioSide.origin + actualStart,
                audioSide.origin + actualEnd);
            if (!audioFragments.length) audioFragments = selectOverlap(
                audioSide.fragments,
                audioSide.origin + (videoSide.kind === "sidx" ? videoFragments[0].time - videoSide.origin : actualStart),
                audioSide.origin + (videoSide.kind === "sidx"
                    ? videoFragments[videoFragments.length - 1].time + videoFragments[videoFragments.length - 1].duration - videoSide.origin
                    : actualEnd));
            planned += (audioSide.initRange.end - audioSide.initRange.start);
            audioFragments.forEach(function (fragment) { planned += fragment.size; });
            audioPack = await pullFragments(audioUrl, audioSide, audioFragments, "audio", signal, tick);
            audioOrigin = audioSide.origin;
        } else if (audioSide.kind === "table") {
            var audioTrack = wantTrack(audioSide, "audio");
            if (!audioTrack) throw CutError("音频文件里没有音频轨");
            audioPack = { info: audioTrack.info, file: audioSide.file, samples: audioTrack.samples, origin: audioSide.origin };
            audioOrigin = audioSide.origin;
        } else {
            audioPack = await pullWhole(audioUrl, "audio", signal, tick);
            audioOrigin = audioPack.origin;
        }

        var audioKept = keepAudio(audioPack.samples, actualStart, actualEnd, audioOrigin);
        if (!audioKept.length) throw CutError("这个区间里没有音频");
        if (audioSide.kind === "table") {
            audioKept.forEach(function (sample) { planned += sample.size; });
            await fillSampleData(audioUrl, audioKept, signal, tick);
        }

        checkAbort(signal);
        var buffer = remux(
            { info: videoPack.info, file: videoPack.file, samples: videoKept, origin: videoOrigin },
            { info: audioPack.info, file: audioPack.file, samples: audioKept, origin: audioOrigin },
            actualStart);
        if (onProgress) onProgress(1);
        return { blob: new Blob([buffer], { type: "video/mp4" }), actualStart: actualStart, actualEnd: actualEnd };
    }

    global.WmcDashCut = { cut: cut };
})(typeof self !== "undefined" ? self : this);
