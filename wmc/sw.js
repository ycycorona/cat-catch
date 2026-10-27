// [WMC] SPEC-001 T6：媒体源判定（仅 MP4 分支）与提交入口。
// 与上游 js/background.js 同一个 SW 全局域：cacheData 由 js/init.js 提供，本文件只读它。
// 消息格式沿用上游：{ Message: "wmcXxx", ... }。

// 同一 URL 的嗅探记录：请求头与 initiator 只从这里取。
function wmcCachedMedia(tabId, url) {
    const list = (self.cacheData && self.cacheData[tabId]) || [];
    return list.find((item) => item.url === url) || null;
}

// MP4 分支：http(s) + Range 探测 206 即可选段。DRM / srcObject 由内容脚本判定后作为入参传入。
async function wmcResolveMedia(tabId, url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { selectable: false };
    let status = 0;
    try {
        const res = await fetch(url, { headers: { Range: "bytes=0-1" }, credentials: "include" });
        status = res.status;
    } catch (e) {
        return { selectable: false };
    }
    if (status !== 206) return { selectable: false };
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
async function wmcHandoff(message, tab) {
    if (typeof message.url !== "string" || !/^https?:\/\//i.test(message.url)) return { ok: false, error: "no-source" };
    const item = wmcCachedMedia(tab.id, message.url);
    const url = new URL(chrome.runtime.getURL("downloader.html"));
    url.searchParams.set("autoClose", "1");
    if (item?.requestId) url.searchParams.set("requestId", item.requestId);
    else url.searchParams.set("JSON", JSON.stringify({
        url: message.url,
        requestId: crypto.randomUUID(),
        title: String(message.pageTitle || tab.title || ""),
        requestHeaders: item?.requestHeaders || {},
        initiator: item?.initiator || message.pageUrl || tab.url,
    }));
    await chrome.tabs.create({ url: url.href, windowId: tab.windowId, index: tab.index + 1, active: false });
    await navigator.locks.request("wmcHandoffs", async () => {
        const { wmcHandoffs = [] } = await chrome.storage.session.get("wmcHandoffs");
        wmcHandoffs.push({
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            pageUrl: String(message.pageUrl || tab.url || ""),
            pageTitle: String(message.pageTitle || tab.title || ""),
            kind: "mp4",
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
    const media = await wmcResolveMedia(tab.id, message.url);
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
            if (message.drm || message.mediaStream) return { selectable: false, kind: null };
            const media = await wmcResolveMedia(tabId, message.currentSrc || message.url);
            return {
                selectable: media.selectable,
                kind: media.kind || null,
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
