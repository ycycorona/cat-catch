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

    if (typeof document !== "undefined") {
        document.addEventListener("ready", function (event) {
            attach(event.detail && event.detail.plyr);
        }, true);
    }

    if (typeof module !== "undefined" && module.exports) module.exports = { bindLiveUrls: bindLiveUrls };
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
    console.log("wmc/sprite-page.js self-check ok");
}
