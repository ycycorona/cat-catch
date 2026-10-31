// [WMC] SPEC-001 T3：HLS 点播切段（独立模块：不读猫抓全局变量与嗅探缓存、不调用上游函数、不设置请求头）。
// 会话 SW 只用 inspect()（能力判定），面板页只用 cut()（执行下载）。
(function (global) {
    "use strict";

    var CONCURRENCY = 4; // 最多 4 个分片并发

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

    // 属性表：KEY=value，"带引号的值可以含逗号"。
    function attrs(text) {
        var out = {};
        var re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
        var m;
        while ((m = re.exec(text))) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, "");
        return out;
    }

    function abs(uri, base) {
        try {
            return new URL(uri, base).href;
        } catch (e) {
            return uri;
        }
    }

    // 解析 master 或媒体播放列表。EXT-X-KEY 按出现顺序作用于后续分片。
    function parse(text, baseUrl) {
        var out = {
            isMaster: false, variants: [], segments: [], map: null,
            endlist: false, audioUri: null, sampleAes: false, mediaSequence: 0,
        };
        var lines = String(text).split(/\r?\n/);
        var key = null;
        var bandwidth = 0;
        var variantNext = false;
        var durationNext = null;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
                bandwidth = Number(attrs(line.slice(18)).BANDWIDTH) || 0;
                variantNext = true;
                out.isMaster = true;
                continue;
            }
            if (line.indexOf("#EXT-X-MEDIA:") === 0) {
                var media = attrs(line.slice(13));
                if (media.TYPE === "AUDIO" && media.URI) out.audioUri = abs(media.URI, baseUrl);
                continue;
            }
            if (line.indexOf("#EXT-X-KEY:") === 0) {
                var k = attrs(line.slice(11));
                if (/^SAMPLE-AES/.test(k.METHOD || "")) out.sampleAes = true;
                key = !k.METHOD || k.METHOD === "NONE" ? null
                    : { method: k.METHOD, uri: k.URI ? abs(k.URI, baseUrl) : null, iv: k.IV || null };
                continue;
            }
            if (line.indexOf("#EXT-X-MAP:") === 0) {
                out.map = abs(attrs(line.slice(11)).URI || "", baseUrl);
                continue;
            }
            if (line.indexOf("#EXTINF:") === 0) {
                durationNext = parseFloat(line.slice(8));
                continue;
            }
            if (line.indexOf("#EXT-X-MEDIA-SEQUENCE:") === 0) {
                out.mediaSequence = Number(line.slice(22)) || 0;
                continue;
            }
            if (line === "#EXT-X-ENDLIST") {
                out.endlist = true;
                continue;
            }
            if (line.charAt(0) === "#") continue;
            if (variantNext) {
                out.variants.push({ bandwidth: bandwidth, url: abs(line, baseUrl) });
                variantNext = false;
            } else if (durationNext !== null) {
                out.segments.push({
                    url: abs(line, baseUrl),
                    duration: durationNext,
                    seq: out.mediaSequence + out.segments.length,
                    key: key,
                });
                durationNext = null;
            }
        }
        return out;
    }

    function total(segments) {
        var sum = 0;
        for (var i = 0; i < segments.length; i++) sum += segments[i].duration;
        return sum;
    }

    function bestVariant(master) {
        var best = null;
        for (var i = 0; i < master.variants.length; i++) {
            if (!best || master.variants[i].bandwidth > best.bandwidth) best = master.variants[i];
        }
        return best;
    }

    async function fetchText(url, signal) {
        checkAbort(signal);
        var res;
        try {
            res = await fetch(url, { credentials: "include", signal: signal });
        } catch (err) {
            if (err && err.name === "AbortError") throw abortError();
            throw CutError("读取播放列表失败：" + (err && err.message));
        }
        if (!res.ok) throw CutError("读取播放列表失败（HTTP " + res.status + "）");
        return res.text();
    }

    async function fetchBytes(url, signal) {
        checkAbort(signal);
        var res;
        try {
            res = await fetch(url, { credentials: "include", signal: signal });
        } catch (err) {
            if (err && err.name === "AbortError") throw abortError();
            throw CutError("分片下载失败：" + (err && err.message));
        }
        if (!res.ok) throw CutError("分片下载失败（HTTP " + res.status + "）");
        return new Uint8Array(await res.arrayBuffer());
    }

    function spriteLists(text, base) {
        if (typeof WmcSprites === "undefined" || !WmcSprites.cuesFromPlaylist) return { cues: [], imagePlaylist: null };
        return WmcSprites.cuesFromPlaylist(text, base);
    }

    // 读一个播放列表：master 先选最高带宽变体。返回判定用字段 + 媒体分片。
    // 图片轨只附加在返回值上，读不到时不影响切段。
    async function inspect(url, signal) {
        var masterText = await fetchText(url, signal);
        var master = parse(masterText, url);
        var playlistUrl = url;
        var media = master;
        var mediaText = masterText;
        if (master.isMaster) {
            var best = bestVariant(master);
            if (!best) throw CutError("master 播放列表里没有变体");
            playlistUrl = best.url;
            mediaText = await fetchText(playlistUrl, signal);
            media = parse(mediaText, playlistUrl);
        }
        var fromMaster = spriteLists(masterText, url);
        var fromMedia = spriteLists(mediaText, playlistUrl);
        return {
            masterUrl: url,
            playlistUrl: playlistUrl,
            variantUrls: master.variants.map(function (variant) { return variant.url; }),
            duration: total(media.segments),
            endlist: media.endlist,
            sampleAes: master.sampleAes || media.sampleAes,
            audioUri: master.audioUri,
            media: media,
            imageCues: fromMedia.cues.length ? fromMedia.cues : fromMaster.cues,
            imagePlaylist: fromMaster.imagePlaylist || fromMedia.imagePlaylist || null,
        };
    }

    function hexBytes(hex) {
        var s = String(hex).replace(/^0x/i, "");
        var out = new Uint8Array(s.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
        return out;
    }

    // 没有 IV 属性时用媒体序列号（16 字节大端），与 HLS 规范一致。
    function seqIv(seq) {
        var iv = new Uint8Array(16);
        var n = seq;
        for (var i = 15; i >= 12; i--) {
            iv[i] = n & 0xff;
            n = Math.floor(n / 256);
        }
        return iv;
    }

    function decryptAes128(bytes, key, iv) {
        return crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, key, bytes)
            .then(function (plain) { return new Uint8Array(plain); })
            .catch(function (e) {
                throw CutError("AES-128 解密失败：" + (e && e.message));
            });
    }

    function stripPicture(bytes) {
        if (!bytes || bytes.length < 8) return bytes;
        var start = -1;
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            for (var i = 0; i < bytes.length - 7; i++) {
                if (bytes[i] === 73 && bytes[i + 1] === 69 && bytes[i + 2] === 78 && bytes[i + 3] === 68) {
                    start = i + 8;
                    break;
                }
            }
        } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            for (var j = 0; j < bytes.length - 1; j++) {
                if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
                    start = j + 2;
                    break;
                }
            }
        }
        return start > 0 && start < bytes.length ? bytes.subarray(start) : bytes;
    }

    function remuxTs(parts) {
        if (typeof muxjs === "undefined" || !muxjs.mp4 || !muxjs.mp4.Transmuxer) return null;
        var transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false, remux: true });
        var init = null;
        var chunks = [];
        transmuxer.on("data", function (segment) {
            if (!init && segment.initSegment) init = segment.initSegment;
            if (segment.data && segment.data.byteLength) chunks.push(segment.data);
        });
        for (var i = 0; i < parts.length; i++) {
            transmuxer.push(parts[i]);
            transmuxer.flush();
        }
        if (!init || !chunks.length) return null;
        return new Blob([init].concat(chunks), { type: "video/mp4" });
    }

    async function segmentBytes(seg, keys, signal) {
        var bytes = stripPicture(await fetchBytes(seg.url, signal));
        if (!seg.key) return bytes;
        if (seg.key.method !== "AES-128") throw CutError("不支持的加密方式：" + seg.key.method);
        if (!seg.key.uri) throw CutError("加密分片缺少密钥 URI");
        var key = keys.get(seg.key.uri);
        if (!key) {
            key = await crypto.subtle.importKey("raw", await fetchBytes(seg.key.uri, signal), { name: "AES-CBC" }, false, ["decrypt"]);
            keys.set(seg.key.uri, key);
        }
        return decryptAes128(bytes, key, seg.key.iv ? hexBytes(seg.key.iv) : seqIv(seg.seq));
    }

    function rebaseFmp4(init, fragments) {
        function invalid() { throw CutError("fMP4 时间戳或 box 结构无效"); }
        function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
        function boxes(data, start, end) {
            var out = [];
            while (start < end) {
                if (end - start < 8) invalid();
                var size = data.getUint32(start);
                var header = 8;
                if (size === 1) {
                    if (end - start < 16) invalid();
                    var large = data.getBigUint64(start + 8);
                    if (large > BigInt(end - start)) invalid();
                    size = Number(large);
                    header = 16;
                } else if (size === 0) size = end - start;
                if (size < header || size > end - start) invalid();
                out.push({
                    type: String.fromCharCode(data.getUint8(start + 4), data.getUint8(start + 5), data.getUint8(start + 6), data.getUint8(start + 7)),
                    start: start + header, end: start + size,
                });
                start += size;
            }
            return out;
        }
        function children(data, parent, type) {
            return boxes(data, parent.start, parent.end).filter(function (box) { return box.type === type; });
        }
        // tkhd.track_ID 与 mdhd.timescale 在各自 v0/v1 FullBox 中的位置相同。
        function timeField(data, box) {
            if (!box || box.end - box.start < 4) invalid();
            var version = data.getUint8(box.start);
            if (version !== 0 && version !== 1) invalid();
            var offset = box.start + (version === 1 ? 20 : 12);
            if (offset + 4 > box.end) invalid();
            return data.getUint32(offset);
        }
        function timestamp(data, box, relativeOffset, scale) {
            if (box.end - box.start < 4 || !scale) invalid();
            var version = data.getUint8(box.start);
            if (version !== 0 && version !== 1) invalid();
            var offset = box.start + relativeOffset;
            if (offset + (version === 1 ? 8 : 4) > box.end) invalid();
            return {
                data: data, offset: offset, version: version, scale: scale,
                time: version === 1 ? data.getBigUint64(offset) : BigInt(data.getUint32(offset)),
            };
        }
        var scales = new Map();
        var edits = [];
        var gap = null;
        var data = view(init);
        // 初始化段不能沿用原片时长；置零后由所选分片确定实际时长。
        function clearDuration(box, offset32, offset64) {
            if (!box || box.end - box.start < 4) invalid();
            var field = timestamp(data, box, data.getUint8(box.start) === 1 ? offset64 : offset32, 1n);
            if (field.version === 1) data.setBigUint64(field.offset, 0n);
            else data.setUint32(field.offset, 0);
        }
        children(data, { start: 0, end: data.byteLength }, "moov").forEach(function (moov) {
            clearDuration(children(data, moov, "mvhd")[0], 16, 24);
            children(data, moov, "mvex").forEach(function (mvex) {
                children(data, mvex, "mehd").forEach(function (mehd) { clearDuration(mehd, 4, 4); });
            });
            children(data, moov, "trak").forEach(function (trak) {
                var tkhd = children(data, trak, "tkhd")[0];
                var id = timeField(data, tkhd);
                clearDuration(tkhd, 20, 28);
                var mdia = children(data, trak, "mdia")[0];
                if (!mdia) invalid();
                var mdhd = children(data, mdia, "mdhd")[0];
                var scale = timeField(data, mdhd);
                clearDuration(mdhd, 16, 24);
                if (!scale) invalid();
                scales.set(id, BigInt(scale));
                var edts = children(data, trak, "edts")[0];
                var elst = edts && children(data, edts, "elst")[0];
                var empty = null;
                if (elst) {
                    if (elst.end - elst.start < 8) invalid();
                    var version = data.getUint8(elst.start);
                    if (version !== 0 && version !== 1) invalid();
                    var width = version === 1 ? 8 : 4;
                    var count = data.getUint32(elst.start + 4);
                    if (8 + count * (width * 2 + 4) > elst.end - elst.start) invalid();
                    if (count) {
                        var offset = elst.start + 8 + width;
                        var mediaTime = version === 1 ? data.getBigInt64(offset) : BigInt(data.getInt32(offset));
                        if (mediaTime === -1n) {
                            empty = timestamp(data, elst, 8, 1n);
                            edits.push(empty);
                        }
                    }
                }
                var delay = empty ? empty.time : 0n;
                if (gap === null || delay < gap) gap = delay;
            });
        });
        var stamps = [];
        var indexes = [];
        var origin = null;
        fragments.forEach(function (bytes) {
            var data = view(bytes);
            var before = stamps.length;
            children(data, { start: 0, end: data.byteLength }, "sidx").forEach(function (sidx) {
                if (sidx.end - sidx.start < 12) invalid();
                indexes.push(timestamp(data, sidx, 12, BigInt(data.getUint32(sidx.start + 8))));
            });
            children(data, { start: 0, end: data.byteLength }, "moof").forEach(function (moof) {
                children(data, moof, "traf").forEach(function (traf) {
                    var tfhd = children(data, traf, "tfhd")[0];
                    if (!tfhd || tfhd.end - tfhd.start < 8) invalid();
                    var scale = scales.get(data.getUint32(tfhd.start + 4));
                    var tfdts = children(data, traf, "tfdt");
                    if (!scale || tfdts.length !== 1) invalid();
                    var tfdt = tfdts[0];
                    var stamp = timestamp(data, tfdt, 4, scale);
                    stamps.push(stamp);
                    if (!origin || stamp.time * origin.scale < origin.time * scale) origin = stamp;
                });
            });
            if (stamps.length === before) invalid();
        });
        stamps.concat(indexes).forEach(function (stamp) {
            // 共用以秒计的原点，保留音视频偏移；换算误差小于该轨一个 tick。
            var time = stamp.time - origin.time * stamp.scale / origin.scale;
            if (time < 0n) invalid();
            if (stamp.version === 1) stamp.data.setBigUint64(stamp.offset, time);
            else stamp.data.setUint32(stamp.offset, Number(time));
        });
        // 空编辑用同一 movie timescale；仅减去共同延迟，保持两轨呈现时间差与 box 大小。
        if (gap > 0n) edits.forEach(function (edit) {
            var time = edit.time - gap;
            if (edit.version === 1) edit.data.setBigUint64(edit.offset, time);
            else edit.data.setUint32(edit.offset, Number(time));
        });
    }

    // WmcHlsCut.cut({ playlistUrl, start, end, signal, onProgress })
    async function cut(opts) {
        var signal = opts && opts.signal;
        var start = Number(opts && opts.start);
        var end = Number(opts && opts.end);
        if (!opts || typeof opts.playlistUrl !== "string") throw CutError("缺少播放列表地址");
        if (!(end > start) || start < 0) throw CutError("选段区间无效");
        checkAbort(signal);
        var info = await inspect(opts.playlistUrl, signal);
        var segments = info.media.segments;
        if (!segments.length) throw CutError("播放列表没有分片");
        if (info.sampleAes) throw CutError("此媒体不支持选段（SAMPLE-AES）");
        if (info.audioUri) throw CutError("此媒体不支持选段（独立音轨）");

        // 按分片边界算实际区间：与 [start, end] 有交集的分片全部取回。
        var cum = 0;
        var picked = [];
        var actualStart = null;
        var actualEnd = 0;
        for (var i = 0; i < segments.length; i++) {
            var s = cum;
            var e = cum + segments[i].duration;
            cum = e;
            if (e > start && s < end) {
                if (actualStart === null) actualStart = s;
                actualEnd = e;
                picked.push(segments[i]);
            }
        }
        if (!picked.length) throw CutError("所选区间内没有分片");

        var parts = [];
        if (info.media.map) parts.push(await fetchBytes(info.media.map, signal));
        var out = new Array(picked.length);
        var keys = new Map();
        var next = 0;
        var done = 0;
        async function worker() {
            for (;;) {
                var index = next++;
                if (index >= picked.length) return;
                out[index] = await segmentBytes(picked[index], keys, signal);
                done++;
                if (opts.onProgress) opts.onProgress(done / picked.length);
            }
        }
        var workers = [];
        for (var w = 0; w < Math.min(CONCURRENCY, picked.length); w++) workers.push(worker());
        await Promise.all(workers);
        if (info.media.map) rebaseFmp4(parts[0], out);
        for (var j = 0; j < out.length; j++) parts.push(out[j]);
        var remuxed = info.media.map ? null : remuxTs(parts);
        if (remuxed) {
            return { blob: remuxed, ext: "mp4", actualStart: actualStart, actualEnd: actualEnd };
        }

        return {
            blob: new Blob(parts, { type: info.media.map ? "video/mp4" : "video/mp2t" }),
            ext: info.media.map ? "mp4" : "ts",
            actualStart: actualStart,
            actualEnd: actualEnd,
        };
    }

    global.WmcHlsCut = { cut: cut, inspect: inspect, parse: parse };
})(typeof self !== "undefined" ? self : this);
