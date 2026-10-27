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

    // 读一个播放列表：master 先选最高带宽变体。返回判定用字段 + 媒体分片。
    async function inspect(url, signal) {
        var master = parse(await fetchText(url, signal), url);
        var playlistUrl = url;
        var media = master;
        if (master.isMaster) {
            var best = bestVariant(master);
            if (!best) throw CutError("master 播放列表里没有变体");
            playlistUrl = best.url;
            media = parse(await fetchText(playlistUrl, signal), playlistUrl);
        }
        return {
            masterUrl: url,
            playlistUrl: playlistUrl,
            duration: total(media.segments),
            endlist: media.endlist,
            sampleAes: master.sampleAes || media.sampleAes,
            audioUri: master.audioUri,
            media: media,
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

    async function segmentBytes(seg, keys, signal) {
        var bytes = await fetchBytes(seg.url, signal);
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
        for (var j = 0; j < out.length; j++) parts.push(out[j]);

        return {
            blob: new Blob(parts, { type: info.media.map ? "video/mp4" : "video/mp2t" }),
            ext: info.media.map ? "mp4" : "ts",
            actualStart: actualStart,
            actualEnd: actualEnd,
        };
    }

    global.WmcHlsCut = { cut: cut, inspect: inspect, parse: parse };
})(typeof self !== "undefined" ? self : this);
