// [WMC] 页面主世界：读播放器时间轴上已经绑好的雪碧图，不猜地址。
(function (root) {
    "use strict";

    function pathParts(url) {
        var text = String(url || "");
        if (text.indexOf("//") === 0) text = "https:" + text;
        return text.split("?")[0].split("/");
    }

    function segmentId(template, live) {
        var parts = pathParts(template);
        var liveParts = pathParts(live);
        if (parts.length !== liveParts.length) return "";
        for (var i = 0; i < parts.length; i++) {
            var at = parts[i].indexOf("{id}");
            if (at < 0) continue;
            var prefix = parts[i].slice(0, at);
            var suffix = parts[i].slice(at + 4);
            var got = liveParts[i];
            if (got.indexOf(prefix) !== 0) continue;
            if (suffix && (got.length < prefix.length + suffix.length || got.slice(-suffix.length) !== suffix)) continue;
            return got.slice(prefix.length, suffix ? got.length - suffix.length : got.length);
        }
        return "";
    }

    function bindLiveUrls(urls, liveSrc) {
        var list = Array.isArray(urls) ? urls : [];
        var id = "";
        if (liveSrc) {
            for (var i = 0; i < list.length && !id; i++) {
                if (String(list[i]).indexOf("{id}") >= 0) id = segmentId(list[i], liveSrc);
            }
        }
        var out = [];
        for (var u = 0; u < list.length; u++) {
            var url = String(list[u] || "");
            if (url.indexOf("//") === 0) url = "https:" + url;
            if (url.indexOf("{id}") >= 0) url = id ? url.split("{id}").join(id) : "";
            if (url && url.indexOf("{") < 0) out.push(url);
        }
        return out;
    }

    function bilibiliConfig(data) {
        if (!data || !Array.isArray(data.index) || data.index.length < 2 || !Array.isArray(data.image) || !data.image.length) return null;
        var grid = [data.img_x_len, data.img_y_len, data.img_x_size, data.img_y_size];
        if (!grid.every(function (n) { return Number.isInteger(n) && n > 0; })) return null;
        // B 站的首项是哨兵；原生播放器用命中的索引减一选格子。
        var times = data.index.slice(1);
        if (times[0] !== 0 || times.length > grid[0] * grid[1] * data.image.length ||
            !times.every(function (n, i) { return Number.isFinite(n) && n >= 0 && (!i || n > times[i - 1]); })) return null;
        var urls = bindLiveUrls(data.image, "");
        if (urls.length !== data.image.length || !urls.every(function (url) { return /^https?:\/\//.test(url); })) return null;
        return { pic_num: times.length, col: grid[0], row: grid[1], width: grid[2], height: grid[3], urls: urls, times: times };
    }

    function publish(media, config, liveSrc) {
        if (!media || !config) return;
        var urls = bindLiveUrls(config.urls, liveSrc);
        if (!(config.pic_num > 0) || !(config.col > 0) || !(config.row > 0) || !(config.width > 0) || !(config.height > 0) || !urls.length) return;
        var spec = {
            pic: Number(config.pic_num),
            col: Number(config.col),
            row: Number(config.row),
            width: Number(config.width),
            height: Number(config.height),
            urls: urls,
        };
        if (config.times) spec.times = config.times;
        var next = JSON.stringify(spec);
        if (media.dataset.wmcThumb === next) return;
        media.dataset.wmcThumb = next;
        media.dispatchEvent(new Event("wmc-thumb"));
    }

    function attach(player) {
        var config = player && player.config && player.config.thumbnail;
        var media = player && player.media;
        if (!config || config.enabled === false || !media || attach.seen.has(media)) return;
        attach.seen.add(media);
        publish(media, config, "");
        var roots = [player.elements && player.elements.progress, player.elements && player.elements.wrapper].filter(Boolean);
        var pull = function () {
            var imgs = [];
            for (var i = 0; i < roots.length; i++) {
                var found = roots[i].querySelectorAll("img");
                for (var j = 0; j < found.length; j++) imgs.push(found[j]);
            }
            for (var k = 0; k < imgs.length; k++) {
                var src = imgs[k].currentSrc || imgs[k].src;
                if (src) publish(media, config, src);
            }
        };
        if (!roots.length) return;
        var obs = new MutationObserver(pull);
        for (var r = 0; r < roots.length; r++) obs.observe(roots[r], { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
        pull();
    }
    attach.seen = new WeakSet();

    function bilibiliTarget(media) {
        try {
            var player = root.player;
            if (!player || player.mediaElement() !== media) return null;
            var input = player.__getUserParams().input;
            if (!Number.isSafeInteger(input.aid) || input.aid <= 0 || !Number.isSafeInteger(input.cid) || input.cid <= 0) return null;
            return { aid: input.aid, cid: input.cid, key: input.aid + "/" + input.cid };
        } catch (e) { return null; }
    }

    var bilibiliRequests = new WeakMap();
    function clearBilibili(media) {
        if (!bilibiliRequests.has(media)) return;
        bilibiliRequests.delete(media);
        delete media.dataset.wmcThumb;
        media.dispatchEvent(new Event("wmc-thumb"));
    }

    async function refreshBilibili(media) {
        if (!Number.isFinite(media.duration) || !(media.duration > 0)) return;
        var target = bilibiliTarget(media);
        if (!target || bilibiliRequests.get(media)?.key === target.key) return;
        clearBilibili(media);
        bilibiliRequests.set(media, target);
        var abort = new AbortController();
        var timeout = setTimeout(function () { abort.abort(); }, 10000);
        try {
            var response = await fetch("https://api.bilibili.com/x/player/videoshot?aid=" + target.aid + "&cid=" + target.cid + "&index=1", { signal: abort.signal });
            if (!response.ok) throw new Error("videoshot unavailable");
            var body = await response.json();
            var config = body.code === 0 && bilibiliConfig(body.data);
            if (!config) throw new Error("videoshot unavailable");
            if (!media.isConnected || bilibiliRequests.get(media) !== target || bilibiliTarget(media)?.key !== target.key) return;
            publish(media, config, "");
        } catch (e) {
            if (bilibiliRequests.get(media) === target) bilibiliRequests.delete(media);
        } finally { clearTimeout(timeout); }
    }

    if (typeof document !== "undefined") {
        document.addEventListener("ready", function (event) {
            attach(event.detail && event.detail.plyr);
        }, true);
        if (/(^|\.)bilibili\.com$/.test(location.hostname)) {
            for (var type of ["loadedmetadata", "durationchange", "play"]) {
                document.addEventListener(type, function (event) {
                    if (event.target instanceof HTMLVideoElement) refreshBilibili(event.target);
                }, true);
            }
            for (var reset of ["emptied", "loadstart"]) {
                document.addEventListener(reset, function (event) {
                    if (event.target instanceof HTMLVideoElement) clearBilibili(event.target);
                }, true);
            }
        }
    }

    if (typeof module !== "undefined" && module.exports) module.exports = { bindLiveUrls: bindLiveUrls, bilibiliConfig: bilibiliConfig };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && require.main === module) {
    var assert = require("assert");
    var api = require("./sprite-page.js");
    var live = "https://surrit.com/a5607be2-7471-4d55-9652-8abeb536a3de/seek/_15.jpg";
    var urls = api.bindLiveUrls([
        "https://surrit.com/{id}/seek/_0.jpg",
        "https://surrit.com/{id}/seek/_15.jpg",
    ], live);
    assert.deepStrictEqual(urls, [
        "https://surrit.com/a5607be2-7471-4d55-9652-8abeb536a3de/seek/_0.jpg",
        "https://surrit.com/a5607be2-7471-4d55-9652-8abeb536a3de/seek/_15.jpg",
    ]);
    assert.deepStrictEqual(api.bindLiveUrls(["https://cdn.example/a.jpg"], ""), ["https://cdn.example/a.jpg"]);
    assert.deepStrictEqual(api.bindLiveUrls(["https://surrit.com/{id}/seek/_0.jpg"], ""), []);
    assert.deepStrictEqual(api.bindLiveUrls(["//{id}.example/seek/_0.jpg"], "https://a5607be2-7471-4d55-9652-8abeb536a3de.example/seek/_15.jpg"), [
        "https://a5607be2-7471-4d55-9652-8abeb536a3de.example/seek/_0.jpg",
    ]);
    var shot = { img_x_len: 2, img_y_len: 2, img_x_size: 160, img_y_size: 90,
        image: ["//cdn.example/sheet.jpg"], index: [0, 0, 5, 11, 17] };
    var config = api.bilibiliConfig(shot);
    assert.deepStrictEqual(config.times, [0, 5, 11, 17]);
    assert.strictEqual(config.pic_num, 4);
    assert.deepStrictEqual(config.urls, ["https://cdn.example/sheet.jpg"]);
    assert.strictEqual(api.bilibiliConfig(Object.assign({}, shot, { index: [] })), null);
    assert.strictEqual(api.bilibiliConfig(Object.assign({}, shot, { index: [0, 0, 11, 5] })), null);
    assert.strictEqual(api.bilibiliConfig(Object.assign({}, shot, { image: ["javascript:bad"] })), null);
    console.log("wmc/sprite-page.js self-check ok");
}
