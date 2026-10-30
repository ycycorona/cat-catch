// [WMC] SPEC-001 T6/T3：媒体源判定（MP4 Range、HLS 点播、不可选原因）与提交入口。
// 与上游 js/background.js 同一个 SW 全局域：cacheData 由 js/init.js 提供，本文件只读它。
// 消息格式沿用上游：{ Message: "wmcXxx", ... }。
importScripts("/wmc/sprites.js", "/wmc/hlscut.js"); // [WMC] 雪碧图解析；只读播放列表，用于 HLS 能力判定

// 不可选段原因（i18n 键，文案在 _locales 里，面板/浮层自己翻译）。
const WMC_REASON = {
    noRange: "wmc_reasonNoRange",
    unknownSource: "wmc_reasonUnknownSource",
    live: "wmc_reasonLive",
    unsupported: "wmc_reasonUnsupported",
};
const WMC_HLS_TOLERANCE = 2; // 秒：播放列表时长与 video.duration 的允许差（SPEC AC-12）

// 同一 URL 的嗅探记录：请求头与 initiator 只从这里取。
function wmcCachedMedia(tabId, url) {
    const list = (self.cacheData && self.cacheData[tabId]) || [];
    return list.find((item) => item.url === url) || null;
}

function wmcDashCandidates(tabId) {
    const list = (self.cacheData && self.cacheData[tabId]) || [];
    return list.filter((item) => /\.mpd(\?|$)|dash\+xml/i.test(`${item.url || ""} ${item.type || ""}`));
}

function wmcVttCandidates(tabId) {
    const list = (self.cacheData && self.cacheData[tabId]) || [];
    const urls = [];
    for (const item of list) {
        const url = item && item.url;
        if (typeof url !== "string") continue;
        if (/\.vtt(\?|#|$)/i.test(url) || /text\/vtt/i.test(item.type || "")) urls.push(url);
    }
    return urls.slice(-6);
}

async function wmcText(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    return res.text();
}

function wmcM3u8Candidates(tabId) {
    const list = (self.cacheData && self.cacheData[tabId]) || [];
    return list
        .filter((item) => /mpegurl|m3u8/i.test(`${item.ext || ""} ${item.type || ""} ${item.url || ""}`))
        .slice(-10);
}

// HLS 分支（MSE 页面）：嗅探记录里找与 video.duration 相差 ≤ 2 秒的唯一播放列表。
async function wmcResolveHls(tabId, duration) {
    const matches = [];
    for (const item of wmcM3u8Candidates(tabId)) {
        let info;
        try {
            info = await WmcHlsCut.inspect(item.url);
        } catch (e) {
            continue;
        }
        if (!info.media.segments.length) continue;
        if (!Number.isFinite(duration) || Math.abs(info.duration - duration) > WMC_HLS_TOLERANCE) continue;
        matches.push({ item, info });
    }
    // [WMC] 只归并 master 明确声明的变体；同长但无关联的媒体仍保留歧义。
    const playlistGroups = new Map();
    for (const { info } of matches) {
        if (!info.variantUrls.length) continue;
        for (const url of [info.masterUrl, ...info.variantUrls]) {
            playlistGroups.set(url, info.playlistUrl);
        }
    }
    const unique = new Map();
    for (const match of matches) {
        const key = playlistGroups.get(match.info.masterUrl) || match.info.playlistUrl;
        const current = unique.get(key);
        if (!current) {
            unique.set(key, { item: match.item, info: { ...match.info } });
            continue;
        }
        current.info.endlist = current.info.endlist && match.info.endlist;
        current.info.sampleAes = current.info.sampleAes || match.info.sampleAes;
        current.info.audioUri = current.info.audioUri || match.info.audioUri;
        if (!current.info.imagePlaylist && match.info.imagePlaylist) current.info.imagePlaylist = match.info.imagePlaylist;
        if (!(current.info.imageCues || []).length && (match.info.imageCues || []).length) current.info.imageCues = match.info.imageCues;
        if (match.info.masterUrl !== match.info.playlistUrl) {
            current.info.masterUrl = match.info.masterUrl;
            current.item = match.item;
        }
    }
    if (unique.size !== 1) {
        // 只有 DASH（.mpd）而没有 HLS 时给「不支持」的定论，避免把确定的不支持说成「找不到」。
        if (unique.size === 0 && wmcDashCandidates(tabId).length) return { selectable: false, reason: WMC_REASON.unsupported };
        return { selectable: false, reason: WMC_REASON.unknownSource };
    }
    const { item, info } = unique.values().next().value;
    const media = {
        kind: "hls",
        hlsUrl: info.masterUrl, // 整段下载交给上游 m3u8 解析页
        requestHeaders: item.requestHeaders || null,
        initiator: item.initiator || null,
    };
    const images = { imageCues: info.imageCues || [], imagePlaylist: info.imagePlaylist || null };
    if (!info.endlist) return { ...media, ...images, selectable: false, reason: WMC_REASON.live };
    if (info.sampleAes || info.audioUri) return { ...media, ...images, selectable: false, reason: WMC_REASON.unsupported };
    return { ...media, ...images, selectable: true };
}

function wmcFindCache(tabId, url) {
    return wmcCachedMedia(tabId, url)
        || ((self.cacheData && self.cacheData[tabId]) || []).find((item) => wmcSameResource(item.url, url))
        || null;
}

// [WMC] 无 MPD 的 Bilibili DASH：视频、音频是两条地址。能读到这两条就按分片选段。
// .m4s 本身也可能属于 HLS，所以只认当前 frame 的播放器数据，不凭扩展名猜。
async function wmcResolveDash(tabId, url, duration, flags) {
    if (!/^blob:https:\/\/(?:[\w-]+\.)*bilibili\.com\//i.test(url)) return null;
    let described = null;
    try {
        const [probe] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [flags?.frameId ?? 0] },
            world: "MAIN",
            func: (src, seconds) => {
                const playing = [...document.querySelectorAll("video")].find((video) =>
                    video.currentSrc === src && Math.abs(video.duration - seconds) <= 2);
                if (!playing) return null;
                const take = (item) => {
                    const address = item && (item.baseUrl || item.base_url || item.url);
                    if (typeof address !== "string" || !/^https?:/i.test(address)) return null;
                    const base = item.SegmentBase || item.segment_base || item.segmentBase || {};
                    return {
                        url: address,
                        init: base.Initialization || base.initialization || null,
                        index: base.indexRange || base.index_range || null,
                    };
                };
                const info = window.__playinfo__?.data;
                const sides = (dash) => {
                    if (!dash?.video?.length || !dash?.audio?.length) return null;
                    let video = dash.video.find((item) => item.id === info?.quality) || null;
                    let audio = null;
                    try {
                        const player = window.player?.__core?.()?.player;
                        const match = (kind, list) => {
                            const tracks = player?.getTracksFor?.(kind) || [];
                            const selected = tracks.find((track) => track.selected) || tracks[0];
                            const selectedUrl = selected?.baseUrl || selected?.url;
                            if (!selectedUrl) return null;
                            return list.find((item) => (item.baseUrl || item.base_url) === selectedUrl) || null;
                        };
                        video = match("video", dash.video) || video;
                        audio = match("audio", dash.audio) || audio;
                    } catch (e) { /* 用下面正在请求的那条 */ }
                    const latest = new Map();
                    for (const entry of performance.getEntriesByType("resource")) {
                        if (!/\.m4s(\?|$)/i.test(entry.name)) continue;
                        try { latest.set(new URL(entry.name).pathname, entry.startTime); } catch (e) { /* 跳过这条记录 */ }
                    }
                    const pick = (list, current) => {
                        if (take(current)) return current;
                        let best = null;
                        let when = -1;
                        for (const item of list) {
                            const address = item && (item.baseUrl || item.base_url || item.url);
                            if (typeof address !== "string") continue;
                            let stamp = null;
                            try { stamp = latest.get(new URL(address).pathname); } catch (e) { stamp = null; }
                            if (stamp == null || stamp < when) continue;
                            best = item;
                            when = stamp;
                        }
                        return best || list[0];
                    };
                    const videoSide = take(pick(dash.video, video));
                    const audioSide = take(pick(dash.audio, audio));
                    if (!videoSide || !audioSide) return null;
                    return {
                        videoUrl: videoSide.url,
                        audioUrl: audioSide.url,
                        videoInit: videoSide.init,
                        videoIndex: videoSide.index,
                        audioInit: audioSide.init,
                        audioIndex: audioSide.index,
                    };
                };
                if (info?.dash?.video?.length && info.dash.audio?.length && Math.abs((info.dash.duration || 0) - seconds) <= 2) {
                    const got = sides(info.dash);
                    if (got) return got;
                }
                try {
                    const player = window.player?.__core?.()?.player;
                    const video = player?.getVideoElement?.();
                    if (!video || video.currentSrc !== src || Math.abs(video.duration - seconds) > 2) return null;
                    const got = sides(player.getSource?.());
                    if (got) return got;
                    if (!player.getTracksFor?.("video")?.length || !player.getTracksFor?.("audio")?.length) return null;
                    const address = (kind) => {
                        const tracks = player.getTracksFor(kind) || [];
                        const selected = tracks.find((track) => track.selected) || tracks[0];
                        const value = selected?.baseUrl || selected?.url;
                        return typeof value === "string" && /^https?:/i.test(value) ? value : null;
                    };
                    return {
                        videoUrl: address("video"),
                        audioUrl: address("audio"),
                        videoInit: null,
                        videoIndex: null,
                        audioInit: null,
                        audioIndex: null,
                    };
                } catch (e) {
                    return null;
                }
            },
            args: [url, duration],
        });
        described = probe?.result || null;
    } catch (e) {
        return null;
    }
    if (!described) return null;
    if (!described.videoUrl || !described.audioUrl) return { selectable: false, reason: WMC_REASON.unsupported };
    const item = wmcFindCache(tabId, described.videoUrl) || wmcFindCache(tabId, described.audioUrl);
    const pageUrl = flags?.pageUrl;
    const requestHeaders = (item && item.requestHeaders) || (pageUrl ? { referer: pageUrl } : null);
    return {
        selectable: true,
        kind: "dash",
        videoUrl: described.videoUrl,
        audioUrl: described.audioUrl,
        videoInit: described.videoInit || null,
        videoIndex: described.videoIndex || null,
        audioInit: described.audioInit || null,
        audioIndex: described.audioIndex || null,
        requestHeaders,
        initiator: (item && item.initiator) || pageUrl || null,
    };
}

// http(s) 走 Range 探测，blob: 走 HLS 判定。DRM / srcObject 由内容脚本判定后作为入参传入。
async function wmcResolveMedia(tabId, url, duration, flags) {
    if (flags && (flags.drm || flags.mediaStream)) return { selectable: false, reason: WMC_REASON.unsupported };
    if (typeof url !== "string" || !url) return { selectable: false, reason: WMC_REASON.unknownSource };
    if (/^blob:/i.test(url)) {
        const media = await wmcResolveHls(tabId, duration);
        if (media.selectable) return media;
        const dash = await wmcResolveDash(tabId, url, duration, flags);
        if (dash) return dash;
        return media;
    }
    if (!/^https?:\/\//i.test(url)) return { selectable: false, reason: WMC_REASON.unknownSource };
    let status = 0;
    try {
        const res = await fetch(url, { headers: { Range: "bytes=0-1" }, credentials: "include" });
        status = res.status;
    } catch (e) {
        return { selectable: false, reason: WMC_REASON.noRange };
    }
    if (status !== 206) return { selectable: false, reason: WMC_REASON.noRange };
    const item = wmcCachedMedia(tabId, url);
    return {
        selectable: true,
        kind: "mp4",
        requestHeaders: (item && item.requestHeaders) || null,
        initiator: (item && item.initiator) || null,
    };
}

// 任务记录在 storage.local。最多留 300 条：从 createdAt 最旧的已结束任务删起，排队中和下载中不删。
const WMC_JOB_LIMIT = 300;
const wmcCapJobs = (jobs) => {
    const kept = jobs.filter((job) => job.status === "queued" || job.status === "running");
    const ended = jobs.filter((job) => job.status !== "queued" && job.status !== "running")
        .sort((a, b) => a.createdAt - b.createdAt);
    const room = Math.max(0, WMC_JOB_LIMIT - kept.length);
    return [...kept, ...ended.slice(ended.length - room)];
};

const wmcReadJobs = async () => {
    const got = await chrome.storage.local.get("wmcJobs");
    return Array.isArray(got.wmcJobs) ? got.wmcJobs : [];
};

// 一次性：旧版本把任务放在 session 里，并入 local 后删掉，避免重启后又迁一次。
const wmcMigrateJobs = async () => {
    const { wmcJobs } = await chrome.storage.session.get("wmcJobs");
    if (!Array.isArray(wmcJobs)) return;
    await navigator.locks.request("wmcJobs", async () => {
        const local = await wmcReadJobs();
        const ids = new Set(local.map((job) => job.id));
        await chrome.storage.local.set({ wmcJobs: wmcCapJobs([...local, ...wmcJobs.filter((job) => !ids.has(job.id))]) });
        await chrome.storage.session.remove("wmcJobs");
    });
};
wmcMigrateJobs();

// 面板单例：按面板 URL 复用已打开的标签页。记下标签页 id，关闭时据此把未完成任务标为已中断。
async function wmcEnsurePanel(active = true) {
    await navigator.locks.request("wmcPanel", async () => {
        const url = chrome.runtime.getURL("wmc/panel.html");
        const tabs = await chrome.tabs.query({});
        const open = tabs.find((tab) => (tab.url || "").split("#")[0] === url);
        const tab = open || (await chrome.tabs.create({ url, active }));
        await chrome.storage.session.set({ wmcPanelTabId: tab.id });
    });
}

// 面板关掉时它的 fetch 也随之结束：把留在 排队中/下载中 的任务标为已中断。
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const { wmcPanelTabId } = await chrome.storage.session.get("wmcPanelTabId");
    if (tabId !== wmcPanelTabId) return;
    await navigator.locks.request("wmcJobs", async () => {
        const jobs = await wmcReadJobs();
        const next = jobs.map((job) =>
            job.status === "queued" || job.status === "running" ? { ...job, status: "interrupted", progress: 0 } : job);
        await chrome.storage.local.set({ wmcJobs: wmcCapJobs(next) });
    });
});

// 整段下载不自建管线：把上游已经嗅探到的资源交给它自己的下载页 / 解析页。
function wmcSameResource(a, b) {
    try {
        const left = new URL(a);
        const right = new URL(b);
        return left.origin === right.origin && left.pathname === right.pathname;
    } catch (e) {
        return a === b;
    }
}

function wmcParsing(item) {
    const type = item.type || "";
    if (item.ext === "m3u8" || item.ext === "m3u" || /mpegurl|octet-stream-m3u8/.test(type)) return "m3u8";
    if (item.ext === "mpd" || type === "application/dash+xml") return "mpd";
    return "";
}

async function wmcPlayerUrls(tabId, frameId) {
    try {
        const [probe] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId ?? 0] },
            world: "MAIN",
            func: () => {
                const urls = [];
                const push = (value) => {
                    if (typeof value === "string" && /^https?:/i.test(value)) urls.push(value);
                };
                try {
                    const info = window.__playinfo__?.data;
                    const dash = info?.dash;
                    if (dash) {
                        const video = (dash.video || []).find((item) => item.id === info.quality) || (dash.video || [])[0];
                        push(video?.baseUrl || video?.base_url);
                        push((dash.audio || [])[0]?.baseUrl || (dash.audio || [])[0]?.base_url);
                    }
                } catch (e) { /* 页面没有这份播放器数据 */ }
                try {
                    const player = window.player?.__core?.()?.player;
                    for (const kind of ["video", "audio"]) {
                        const tracks = player?.getTracksFor?.(kind) || [];
                        const selected = tracks.find((track) => track.selected) || tracks[0];
                        push(selected?.baseUrl || selected?.url);
                    }
                } catch (e) { /* 播放器没有当前轨地址 */ }
                return [...new Set(urls)];
            },
        });
        return Array.isArray(probe?.result) ? probe.result : [];
    } catch (e) {
        return [];
    }
}

function wmcSniffedHls(tabId, url) {
    if (!/^blob:/i.test(url || "")) return null;
    const picked = wmcPickM3u8((self.cacheData && self.cacheData[tabId]) || []);
    if (!picked) return null;
    return {
        selectable: true,
        kind: "hls",
        hlsUrl: picked.url,
        requestHeaders: picked.requestHeaders || null,
        initiator: picked.initiator || null,
    };
}

async function wmcMediaFor(tabId, url, duration, flags) {
    const media = await wmcResolveMedia(tabId, url, duration, flags);
    if (media.selectable) return media;
    return wmcSniffedHls(tabId, url) || media;
}

function wmcMatchCache(tabId, urls) {
    const list = (self.cacheData && self.cacheData[tabId]) || [];
    const found = [];
    for (const url of urls) {
        const item = list.find((entry) => entry.url === url) || list.find((entry) => wmcSameResource(entry.url, url));
        if (item && !found.some((entry) => entry.requestId === item.requestId)) found.push(item);
    }
    return found;
}

function wmcPickM3u8(items) {
    const lists = items.filter((item) => wmcParsing(item) === "m3u8");
    const media = lists.filter((item) => /\/video\.m3u8(\?|$)/i.test(item.url));
    const pool = media.length ? media : lists.filter((item) => !/\/playlist\.m3u8(\?|$)/i.test(item.url));
    const choice = (pool.length ? pool : lists);
    return choice.length ? choice[choice.length - 1] : null;
}

async function wmcOpenUpstream(tab, page) {
    await chrome.tabs.create({
        url: page,
        windowId: tab.windowId,
        index: tab.index + 1,
        active: !(self.G && self.G.downActive),
    });
}

// AC-11：没有选段时走上游下载。有选段的任务仍由本扩展的面板执行。
async function wmcHandoff(message, tab, frameId) {
    const urls = [];
    if (/^https?:\/\//i.test(message.url || "")) urls.push(message.url);
    if (/^blob:/i.test(message.url || "")) urls.push(...await wmcPlayerUrls(tab.id, frameId));
    let items = wmcMatchCache(tab.id, urls);
    if (!items.length) {
        const picked = wmcPickM3u8((self.cacheData && self.cacheData[tab.id]) || []);
        if (picked) items = [picked];
    }
    if (!items.length) {
        const media = await wmcResolveMedia(tab.id, message.url, message.duration, { frameId });
        if (media.hlsUrl) items = wmcMatchCache(tab.id, [media.hlsUrl]);
        if (!items.length && media.hlsUrl) {
            items = [{
                url: media.hlsUrl,
                ext: "m3u8",
                requestHeaders: media.requestHeaders,
                initiator: media.initiator,
                title: message.pageTitle,
                tabId: tab.id,
            }];
        }
        if (!items.length && /^https?:\/\//i.test(message.url || "")) {
            const page = new URL(chrome.runtime.getURL("downloader.html"));
            page.searchParams.set("autoClose", "1");
            page.searchParams.set("JSON", JSON.stringify({
                url: message.url,
                requestId: crypto.randomUUID(),
                title: String(message.pageTitle || tab.title || ""),
                requestHeaders: {},
                initiator: message.pageUrl || tab.url,
            }));
            await wmcOpenUpstream(tab, page.href);
            return { ok: true };
        }
        if (!items.length) return { ok: false, error: media.reason || "no-source" };
    }
    const pickedM3u8 = wmcPickM3u8(items);
    if (pickedM3u8) items = items.filter((item) => wmcParsing(item) !== "m3u8").concat(pickedM3u8);
    const files = [];
    let opened = 0;
    for (const item of items) {
        const parsing = wmcParsing(item);
        if (!parsing) { files.push(item); continue; }
        const page = new URL(chrome.runtime.getURL(`${parsing}.html`));
        page.searchParams.set("url", item.url);
        page.searchParams.set("title", String(item.title || message.pageTitle || tab.title || ""));
        if (item.downFileName) page.searchParams.set("filename", item.downFileName);
        page.searchParams.set("tabid", String(item.tabId == null ? tab.id : item.tabId));
        if (item.initiator) page.searchParams.set("initiator", item.initiator);
        if (item.requestHeaders) page.searchParams.set("requestHeaders", JSON.stringify(item.requestHeaders));
        if (parsing === "m3u8" && (!self.G || self.G.m3u8AutoDown !== false)) {
            page.searchParams.set("autoDown", "1");
            page.searchParams.set("wmcMp4", "1");
        }
        await wmcOpenUpstream(tab, page.href);
        opened += 1;
    }
    const ready = files.filter((item) => item.requestId);
    if (ready.length) {
        const page = new URL(chrome.runtime.getURL("downloader.html"));
        page.searchParams.set("requestId", ready.map((item) => item.requestId).join(","));
        page.searchParams.set("autoClose", "1");
        await wmcOpenUpstream(tab, page.href);
        opened += 1;
    }
    return opened ? { ok: true } : { ok: false, error: "no-source" };
}

async function wmcSubmit(message, sender) {
    const tab = sender.tab;
    if (!tab || typeof tab.id !== "number") return { ok: false, error: "no-tab" };
    const segments = message.segments;
    if (!Array.isArray(segments)) return { ok: false, error: "bad-segments" };
    if (!segments.length) return wmcHandoff(message, tab, sender.frameId);
    if (!Number.isFinite(message.duration) || message.duration < 10 ||
        segments.some((seg) => !seg || !Number.isSafeInteger(seg.segIndex) || seg.segIndex < 0 ||
            !Number.isFinite(seg.start) || !Number.isFinite(seg.end) ||
            seg.start < 0 || seg.end <= seg.start || seg.end > message.duration) ||
        new Set(segments.map((seg) => seg.segIndex)).size !== segments.length) return { ok: false, error: "bad-range" };
    const media = await wmcMediaFor(tab.id, message.url, message.duration, {
        frameId: sender.frameId,
        pageUrl: message.pageUrl || tab.url,
    });
    if (!media.selectable) return { ok: false, error: media.reason || "not-selectable" };
    // 提交时整体快照（字段见 SPEC「Interfaces and data」），之后改选段不影响这条记录。
    const submitted = segments.map((seg) => ({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        pageUrl: String(message.pageUrl || tab.url || ""),
        pageTitle: String(message.pageTitle || tab.title || ""),
        tabId: tab.id,
        mediaUrl: message.url,
        kind: media.kind,
        sourceUrl: media.hlsUrl || media.videoUrl || message.url, // HLS 记播放列表；DASH 记视频地址
        requestHeaders: media.requestHeaders,
        initiator: media.initiator,
        videoUrl: media.videoUrl || null,
        audioUrl: media.audioUrl || null,
        videoInit: media.videoInit || null,
        videoIndex: media.videoIndex || null,
        audioInit: media.audioInit || null,
        audioIndex: media.audioIndex || null,
        segIndex: seg.segIndex,
        start: seg.start,
        end: seg.end,
        actualStart: null,
        actualEnd: null,
        status: "queued",
        progress: 0,
        error: null,
        fileName: null,
    }));
    // 与面板的状态更新互斥，避免提交时被旧的进度快照覆盖。
    await navigator.locks.request("wmcJobs", async () => {
        const jobs = await wmcReadJobs();
        jobs.push(...submitted);
        await chrome.storage.local.set({ wmcJobs: wmcCapJobs(jobs) });
    });
    await wmcEnsurePanel();
    return { ok: true, ids: submitted.map((job) => job.id) };
}

// session storage 默认不对内容脚本开放，只推送任务快照，不扩大 storage 的访问级别。
chrome.storage.local.onChanged.addListener(async (changes) => {
    if (!changes.wmcJobs) return;
    const tabs = await chrome.tabs.query({});
    const jobs = await wmcReadJobs();
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { Message: "wmcJobsChanged", jobs }).catch(() => {});
});

// 上游 background.js 也监听同一批消息（它只认自己的 Message 值），这里只接管 wmc 前缀。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || typeof message.Message !== "string") return;
    if (!message.Message.startsWith("wmc")) return;
    const settle = (promise) =>
        promise.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    if (message.Message === "wmcGetJobs") {
        settle(wmcReadJobs().then((jobs) => ({ jobs })));
        return true;
    }
    if (message.Message === "wmcResolve") {
        settle((async () => {
            const tabId = sender.tab && sender.tab.id;
            if (message.drm || message.mediaStream) return { selectable: false, kind: null, reason: WMC_REASON.unsupported };
            const media = await wmcMediaFor(tabId, message.currentSrc || message.url, message.duration, {
                frameId: sender.frameId,
                pageUrl: sender.tab && sender.tab.url,
            });
            let imageCues = media.imageCues || [];
            let vttCues = [];
            if (typeof WmcSprites !== "undefined") {
                if (!imageCues.length && media.imagePlaylist) {
                    try {
                        imageCues = WmcSprites.cuesFromPlaylist(await wmcText(media.imagePlaylist), media.imagePlaylist).cues || [];
                    } catch (e) { /* 图片轨跨源或失败就当没有 */ }
                }
                for (const url of wmcVttCandidates(tabId)) {
                    try {
                        const cues = WmcSprites.parseVtt(await wmcText(url), url);
                        if (cues.length) { vttCues = cues; break; }
                    } catch (e) { /* 这一条取不到就试下一条 */ }
                }
            }
            return {
                selectable: media.selectable,
                kind: media.kind || null,
                reason: media.reason || null,
                requestHeaders: media.requestHeaders || null,
                initiator: media.initiator || null,
                vttCues,
                imageCues,
                hlsUrl: media.hlsUrl || null,
            };
        })());
        return true;
    }
    if (message.Message === "wmcSubmit") {
        settle(wmcSubmit(message, sender));
        return true;
    }
    // 浮窗上的任务胶囊：打开任务面板并切到它，已打开就直接切过去。
    if (message.Message === "wmcOpenPanel") {
        settle((async () => {
            await wmcEnsurePanel(true);
            const { wmcPanelTabId } = await chrome.storage.session.get("wmcPanelTabId");
            const tab = await chrome.tabs.update(wmcPanelTabId, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
            return { ok: true };
        })());
        return true;
    }
    sendResponse({ ok: false, error: "unknown" });
    return true;
});
