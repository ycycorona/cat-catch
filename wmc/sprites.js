// [WMC] 细节轴雪碧图：WebVTT、HLS 图片轨、页面内联 thumbnail。不读猫抓全局。
(function (root) {
    "use strict";

    function parseClock(text) {
        var t = String(text).trim();
        var three = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
        if (three) return (Number(three[1] || 0) * 3600) + Number(three[2]) * 60 + Number(three[3]);
        var one = /^(\d+(?:\.\d+)?)$/.exec(t);
        return one ? Number(one[1]) : NaN;
    }

    function absUrl(url, base) {
        try {
            return new URL(url, base || undefined).href;
        } catch (e) {
            return url;
        }
    }

    function imageCue(raw, start, end, base) {
        var xy = String(raw).match(/[#?]xywh=(\d+),(\d+),(\d+),(\d+)/i);
        var urlPart = String(raw).replace(/[#?]xywh=\d+,\d+,\d+,\d+/i, "").trim();
        if (!urlPart || /[{}]/.test(urlPart)) return null;
        var url = absUrl(urlPart, base);
        if (!/^https?:/i.test(url)) return null;
        if (!xy && !/\.(jpe?g|png|webp)(\?|#|$)/i.test(urlPart)) return null;
        return {
            start: start, end: end, url: url,
            x: xy ? Number(xy[1]) : 0, y: xy ? Number(xy[2]) : 0,
            w: xy ? Number(xy[3]) : 0, h: xy ? Number(xy[4]) : 0,
            cols: 1, rows: 1, col: 0, row: 0,
        };
    }

    function imagesFromLine(line, start, end, base) {
        var found = String(line).match(/(\S*#xywh=\d+,\d+,\d+,\d+|\S*\?xywh=\d+,\d+,\d+,\d+|\S+\.(?:jpe?g|png|webp)\S*)/i);
        if (!found) return [];
        var cue = imageCue(found[1], start, end, base);
        return cue ? [cue] : [];
    }

    function parseVtt(text, base) {
        var lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
        var cues = [];
        var i = 0;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("-->") < 0) i++;
        while (i < lines.length) {
            var line = lines[i].trim();
            if (!line || line.indexOf("NOTE") === 0 || line.indexOf("STYLE") === 0 || line.indexOf("REGION") === 0) {
                i++;
                continue;
            }
            if (line.indexOf("-->") < 0 && i + 1 < lines.length && lines[i + 1].indexOf("-->") >= 0) {
                i++;
                line = lines[i].trim();
            }
            var timing = /(\S+)\s+-->\s+(\S+)/.exec(line);
            if (!timing) { i++; continue; }
            var start = parseClock(timing[1]);
            var end = parseClock(timing[2]);
            i++;
            var body = [];
            while (i < lines.length && lines[i].trim()) body.push(lines[i].trim()), i++;
            if (Number.isFinite(start) && Number.isFinite(end)) {
                for (var b = 0; b < body.length; b++) cues.push.apply(cues, imagesFromLine(body[b], start, end, base));
            }
        }
        return cues;
    }

    function fromTracks(video) {
        var cues = [];
        var tracks = video && video.textTracks ? video.textTracks : [];
        for (var t = 0; t < tracks.length; t++) {
            var list = tracks[t].cues;
            if (!list) continue;
            for (var c = 0; c < list.length; c++) {
                var cue = list[c];
                var rows = String(cue.text || "").split(/\n/);
                for (var r = 0; r < rows.length; r++) cues.push.apply(cues, imagesFromLine(rows[r], cue.startTime, cue.endTime));
            }
        }
        return cues;
    }

    function specFromText(text) {
        var src = String(text || "");
        if (src.indexOf("pic_num") < 0 || src.indexOf("urls") < 0) return null;
        var num = function (name) {
            var m = new RegExp(name + "\\s*:\\s*(\\d+)").exec(src);
            return m ? Number(m[1]) : 0;
        };
        var urlsBlock = /urls\s*:\s*\[([\s\S]*?)\]/.exec(src);
        if (!urlsBlock) return null;
        var urls = [];
        var re = /["']((?:https?:)?\/\/[^"']+)["']/g;
        var hit;
        while ((hit = re.exec(urlsBlock[1]))) {
            var raw = hit[1].indexOf("//") === 0 ? "https:" + hit[1] : hit[1];
            // 只留 {id}。别的花括号填不上，放开会请求到坏地址。
            if (/\{(?!id\})/.test(raw)) continue;
            urls.push(raw);
        }
        var spec = {
            pic: num("pic_num"), col: num("col"), row: num("row"),
            width: num("width"), height: num("height"), urls: urls,
        };
        if (!(spec.pic > 0 && spec.col > 0 && spec.row > 0 && spec.width > 0 && spec.height > 0 && urls.length)) return null;
        return spec;
    }

    function cuesFromSpec(spec, duration) {
        var step = duration / spec.pic;
        var per = spec.col * spec.row;
        var cues = [];
        for (var i = 0; i < spec.pic; i++) {
            var url = spec.urls[Math.floor(i / per)];
            if (!url) break;
            var cell = i % per;
            var col = cell % spec.col;
            var row = Math.floor(cell / spec.col);
            cues.push({
                start: i * step, end: (i + 1) * step, url: url,
                x: col * spec.width, y: row * spec.height, w: spec.width, h: spec.height,
                cols: spec.col, rows: spec.row, col: col, row: row,
            });
        }
        return cues;
    }

    function uuidOnHost(url, haystack) {
        var host;
        try { host = new URL(url).host; } catch (e) { return ""; }
        var re = new RegExp("https?://" + host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", "i");
        var found = re.exec(haystack || "");
        return found ? found[1] : "";
    }

    function bindUrl(url, primary, fallback) {
        if (url.indexOf("{id}") < 0) return url;
        var id = uuidOnHost(url, primary) || uuidOnHost(url, fallback);
        return id ? url.split("{id}").join(id) : "";
    }

    function fromInline(doc, duration, extra) {
        if (!doc || !(duration > 0) || !doc.querySelectorAll) return [];
        var scripts = doc.querySelectorAll("script:not([src])");
        var page = "";
        try { page = doc.documentElement ? doc.documentElement.innerHTML : ""; } catch (e) { page = ""; }
        for (var i = 0; i < scripts.length; i++) {
            var text = scripts[i].textContent || "";
            var spec = specFromText(text);
            if (!spec) continue;
            var urls = [];
            for (var u = 0; u < spec.urls.length; u++) {
                var bound = bindUrl(spec.urls[u], extra, text + "\n" + page);
                if (bound) urls.push(bound);
            }
            if (!urls.length) continue;
            spec.urls = urls;
            return cuesFromSpec(spec, duration);
        }
        return [];
    }

    function attrs(text) {
        var out = {};
        var re = /([A-Za-z0-9-]+)=("([^"]*)"|[^,]*)/g;
        var m;
        while ((m = re.exec(text))) out[m[1].toUpperCase()] = m[3] != null ? m[3] : String(m[2]).replace(/^"|"$/g, "");
        return out;
    }

    function tileCues(url, start, duration, tiles) {
        var layout = /^(\d+)x(\d+)$/i.exec((tiles && tiles.LAYOUT) || "");
        var res = /^(\d+)x(\d+)$/i.exec((tiles && tiles.RESOLUTION) || "");
        var cols = layout ? Number(layout[1]) : 1;
        var rows = layout ? Number(layout[2]) : 1;
        var tw = res ? Number(res[1]) : 0;
        var th = res ? Number(res[2]) : 0;
        var each = tiles && Number(tiles.DURATION) > 0 ? Number(tiles.DURATION) : duration / (cols * rows);
        var cues = [];
        var n = Math.max(1, cols * rows);
        for (var k = 0; k < n; k++) {
            var a = start + k * each;
            var b = Math.min(start + (k + 1) * each, start + duration);
            if (!(b > a)) break;
            var col = k % cols;
            var row = Math.floor(k / cols);
            cues.push({
                start: a, end: b, url: url,
                x: tw ? col * tw : 0, y: th ? row * th : 0, w: tw, h: th,
                cols: cols, rows: rows, col: col, row: row,
            });
        }
        return cues;
    }

    // 只认图片轨。视频分片和 I 帧播放列表不当成雪碧图。
    function cuesFromPlaylist(text, base) {
        var lines = String(text || "").split(/\r?\n/);
        var cues = [];
        var imagePlaylist = null;
        var tiles = null;
        var dur = null;
        var t = 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf("#EXT-X-I-FRAME-STREAM-INF:") === 0) continue;
            if (line.indexOf("#EXT-X-IMAGE-STREAM-INF:") === 0) {
                var uri = attrs(line.slice(24)).URI;
                if (uri) imagePlaylist = absUrl(uri, base);
                continue;
            }
            if (line.indexOf("#EXT-X-TILES:") === 0) {
                tiles = attrs(line.slice(13));
                continue;
            }
            if (line.indexOf("#EXTINF:") === 0) {
                dur = parseFloat(line.slice(8));
                continue;
            }
            if (!line || line.charAt(0) === "#") continue;
            if (!(dur > 0)) { tiles = null; continue; }
            var url = absUrl(line, base);
            var image = /\.(jpe?g|png|webp)(\?|#|$)/i.test(line);
            if (tiles || image) cues.push.apply(cues, tileCues(url, t, dur, tiles));
            t += dur;
            dur = null;
            tiles = null;
        }
        return { cues: cues, imagePlaylist: imagePlaylist };
    }

    function cueAt(cues, time) {
        if (!cues || !cues.length) return null;
        var lo = 0;
        var hi = cues.length - 1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            var cue = cues[mid];
            if (time < cue.start) hi = mid - 1;
            else if (time >= cue.end) lo = mid + 1;
            else return cue;
        }
        var last = cues[cues.length - 1];
        return time >= last.start ? last : null;
    }

    var api = {
        parseVtt: parseVtt,
        fromTracks: fromTracks,
        specFromText: specFromText,
        cuesFromSpec: cuesFromSpec,
        fromInline: fromInline,
        cuesFromPlaylist: cuesFromPlaylist,
        cueAt: cueAt,
    };
    root.WmcSprites = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && require.main === module) {
    var assert = require("assert");
    var api = require("./sprites.js");
    var vtt = api.parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nstoryboard.jpg#xywh=0,0,160,90\n\n00:05.000 --> 00:10.000\nhttp://cdn.example/b.jpg?xywh=160,0,160,90\n", "http://example.com/t.vtt");
    assert.strictEqual(vtt.length, 2);
    assert.strictEqual(vtt[0].url, "http://example.com/storyboard.jpg");
    assert.strictEqual(vtt[0].w, 160);
    assert.strictEqual(vtt[1].url, "http://cdn.example/b.jpg");
    assert.strictEqual(vtt[1].x, 160);
    assert.strictEqual(api.cueAt(vtt, 5).url, vtt[1].url);
    assert.strictEqual(api.cueAt(vtt, 10).x, 160);

    var spec = api.specFromText('thumbnail:{pic_num:8,width:10,height:5,col:2,row:2,urls:["https://cdn.example/a.jpg","https://cdn.example/{id}/b.jpg","https://cdn.example/{token}/c.jpg"]}');
    assert.deepStrictEqual(spec.urls, ["https://cdn.example/a.jpg", "https://cdn.example/{id}/b.jpg"]);
    var doc = { querySelectorAll: function () { return [{ textContent: 'thumbnail:{pic_num:4,width:10,height:5,col:2,row:2,urls:["https://surrit.com/{id}/seek/_0.jpg"]}' }]; } };
    assert.strictEqual(api.fromInline(doc, 8).length, 0);
    var filled = api.fromInline(doc, 8, "https://surrit.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/playlist.m3u8");
    assert.strictEqual(filled[0].url, "https://surrit.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/seek/_0.jpg");
    var cells = api.cuesFromSpec({ pic: 8, col: 2, row: 2, width: 10, height: 5, urls: ["https://cdn.example/a.jpg", "https://cdn.example/c.jpg"] }, 8);
    assert.strictEqual(cells[4].url, "https://cdn.example/c.jpg");
    assert.strictEqual(cells[4].x, 0);
    assert.strictEqual(cells[5].x, 10);
    assert.strictEqual(api.specFromText("pic_num: 1"), null);

    var sheet = api.cuesFromPlaylist("#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:URI=\"iframes.m3u8\"\n#EXTINF:4,\n#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=2x2,DURATION=1\nsheet.jpg\n#EXTINF:4,\nseg.ts\n", "http://example.com/p.m3u8");
    assert.strictEqual(sheet.imagePlaylist, null);
    assert.strictEqual(sheet.cues.length, 4);
    assert.strictEqual(sheet.cues[3].x, 160);
    assert.strictEqual(sheet.cues[3].y, 90);
    assert.strictEqual(sheet.cues[3].start, 3);
    var pointer = api.cuesFromPlaylist('#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1,URI="thumbs.m3u8"\n', "http://example.com/master.m3u8");
    assert.strictEqual(pointer.imagePlaylist, "http://example.com/thumbs.m3u8");
    assert.strictEqual(pointer.cues.length, 0);
    var miss = api.cuesFromSpec({ pic: 3461, col: 6, row: 6, width: 300, height: 168, urls: Array.from({ length: 97 }, function (_, n) { return "https://cdn.example/_" + n + ".jpg"; }) }, 6920);
    assert.strictEqual(api.cueAt(miss, 6920 * 0.35).url, "https://cdn.example/_33.jpg");
    console.log("wmc/sprites.js self-check ok");
}
