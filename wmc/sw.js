// [WMC] SPEC-001 T6/T3：媒体源判定（MP4 Range、HLS 点播、不可选原因）与提交入口。
// 与上游 js/background.js 同一个 SW 全局域：cacheData 由 js/init.js 提供，本文件只读它。
// 消息格式沿用上游：{ Message: "wmcXxx", ... }。
importScripts("/wmc/hlscut.js"); // [WMC] 只读播放列表，用于 HLS 能力判定

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
    // 同一个源会同时嗅到 master 与变体：按解析出的媒体播放列表去重，
    // 但不可选条件（ENDLIST / SAMPLE-AES / 独立音轨）要合并，不能只留最后一个。
    const unique = new Map();
    for (const match of matches) {
        const current = unique.get(match.info.playlistUrl);
        if (!current) {
            unique.set(match.info.playlistUrl, { item: match.item, info: { ...match.info } });
            continue;
        }
        current.info.endlist = current.info.endlist && match.info.endlist;
        current.info.sampleAes = current.info.sampleAes || match.info.sampleAes;
        current.info.audioUri = current.info.audioUri || match.info.audioUri;
        if (match.info.masterUrl !== match.info.playlistUrl) {
            current.info.masterUrl = match.info.masterUrl;
            current.item = match.item;
        }
    }
    if (unique.size !== 1) return { selectable: false, reason: WMC_REASON.unknownSource };
    const { item, info } = unique.values().next().value;
    const media = {
        kind: "hls",
        hlsUrl: info.masterUrl, // 整段下载交给上游 m3u8 解析页
        requestHeaders: item.requestHeaders || null,
        initiator: item.initiator || null,
    };
    if (!info.endlist) return { ...media, selectable: false, reason: WMC_REASON.live };
    if (info.sampleAes || info.audioUri) return { ...media, selectable: false, reason: WMC_REASON.unsupported };
    return { ...media, selectable: true };
}

// http(s) 走 Range 探测，blob: 走 HLS 判定。DRM / srcObject 由内容脚本判定后作为入参传入。
async function wmcResolveMedia(tabId, url, duration, flags) {
    if (flags && (flags.drm || flags.mediaStream)) return { selectable: false, reason: WMC_REASON.unsupported };
    if (typeof url !== "string" || !url) return { selectable: false, reason: WMC_REASON.unknownSource };
    if (/^blob:/i.test(url)) return wmcResolveHls(tabId, duration);
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

const wmcReadJobs = async () => {
    const got = await chrome.storage.session.get("wmcJobs");
    return Array.isArray(got.wmcJobs) ? got.wmcJobs : [];
};

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
        await chrome.storage.session.set({ wmcJobs: next });
    });
});

// AC-11：交接提示与下载任务分开保存，不伪造下载进度或“已完成”。
// MP4 交给上游下载页；HLS（blob: 源）交给上游 m3u8 解析页，仍开在右邻后台标签并自动关闭。
async function wmcHandoff(message, tab) {
    const media = await wmcResolveMedia(tab.id, message.url, message.duration, {});
    let url;
    if (/^https?:\/\//i.test(message.url)) {
        const item = wmcCachedMedia(tab.id, message.url);
        url = new URL(chrome.runtime.getURL("downloader.html"));
        url.searchParams.set("autoClose", "1");
        if (item?.requestId) url.searchParams.set("requestId", item.requestId);
        else url.searchParams.set("JSON", JSON.stringify({
            url: message.url,
            requestId: crypto.randomUUID(),
            title: String(message.pageTitle || tab.title || ""),
            requestHeaders: item?.requestHeaders || {},
            initiator: item?.initiator || message.pageUrl || tab.url,
        }));
    } else {
        const hlsUrl = media.hlsUrl;
        if (!hlsUrl) return { ok: false, error: "no-source" };
        const item = wmcCachedMedia(tab.id, hlsUrl);
        url = new URL(chrome.runtime.getURL("m3u8.html"));
        url.searchParams.set("url", hlsUrl);
        url.searchParams.set("tabid", String(tab.id));
        url.searchParams.set("autoDown", "1");
        url.searchParams.set("autoClose", "1");
        url.searchParams.set("title", String(message.pageTitle || tab.title || ""));
        if (item?.requestHeaders) url.searchParams.set("requestHeaders", JSON.stringify(item.requestHeaders));
        const initiator = item?.initiator || message.pageUrl || tab.url;
        if (initiator) url.searchParams.set("initiator", initiator);
    }
    await chrome.tabs.create({ url: url.href, windowId: tab.windowId, index: tab.index + 1, active: false });
    await navigator.locks.request("wmcHandoffs", async () => {
        const { wmcHandoffs = [] } = await chrome.storage.session.get("wmcHandoffs");
        wmcHandoffs.push({
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            pageUrl: String(message.pageUrl || tab.url || ""),
            pageTitle: String(message.pageTitle || tab.title || ""),
            kind: media.kind || "mp4",
            openedUrl: url.href,
        });
        await chrome.storage.session.set({ wmcHandoffs });
    });
    await wmcEnsurePanel(false);
    return { ok: true };
}

async function wmcSubmit(message, sender) {
    const tab = sender.tab;
    if (!tab || typeof tab.id !== "number") return { ok: false, error: "no-tab" };
    const segments = message.segments;
    if (!Array.isArray(segments) || segments.length > 2) return { ok: false, error: "bad-segments" };
    if (!segments.length) return wmcHandoff(message, tab);
    if (!Number.isFinite(message.duration) || message.duration < 10 ||
        segments.some((seg) => !seg || ![0, 1].includes(seg.segIndex) ||
            !Number.isFinite(seg.start) || !Number.isFinite(seg.end) ||
            seg.start < 0 || seg.end <= seg.start || seg.end > message.duration) ||
        new Set(segments.map((seg) => seg.segIndex)).size !== segments.length) return { ok: false, error: "bad-range" };
    const media = await wmcResolveMedia(tab.id, message.url, message.duration, {});
    if (!media.selectable) return { ok: false, error: "not-selectable" };
    // 提交时整体快照（字段见 SPEC「Interfaces and data」），之后改选段不影响这条记录。
    const submitted = segments.map((seg) => ({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        pageUrl: String(message.pageUrl || tab.url || ""),
        pageTitle: String(message.pageTitle || tab.title || ""),
        tabId: tab.id,
        mediaUrl: message.url,
        kind: media.kind,
        sourceUrl: media.hlsUrl || message.url, // HLS 的 blob: 源用它存播放列表地址
        requestHeaders: media.requestHeaders,
        initiator: media.initiator,
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
        await chrome.storage.session.set({ wmcJobs: jobs });
    });
    await wmcEnsurePanel();
    return { ok: true, ids: submitted.map((job) => job.id) };
}

// session storage 默认不对内容脚本开放，只推送任务快照，不扩大 storage 的访问级别。
chrome.storage.session.onChanged.addListener(async (changes) => {
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
            const media = await wmcResolveMedia(tabId, message.currentSrc || message.url, message.duration, {});
            return {
                selectable: media.selectable,
                kind: media.kind || null,
                reason: media.reason || null,
                requestHeaders: media.requestHeaders || null,
                initiator: media.initiator || null,
            };
        })());
        return true;
    }
    if (message.Message === "wmcSubmit") {
        settle(wmcSubmit(message, sender));
        return true;
    }
    sendResponse({ ok: false, error: "unknown" });
    return true;
});
