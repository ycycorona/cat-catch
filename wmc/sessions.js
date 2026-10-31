// 分段会话：同一个页面地址最多 5 条，这台机器一共最多 200 条。同一条会话反复编辑会覆盖自己。
// shortcut: 多标签同时改同一条时后写入的那次为准；不做逐次撤销。要保留编辑历史再改成快照。
(function (root) {
    const KEY = "wmcClipSessions";
    const PER_URL = 5;
    const GLOBAL = 200;

    const freshId = () => crypto.randomUUID();

    const clipSegments = (list, duration) => {
        if (!Array.isArray(list)) return [];
        const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
        const out = [];
        for (const seg of list) {
            const start = Number(seg?.start);
            const end = Number(seg?.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const clippedStart = Math.max(0, start);
            const clippedEnd = Math.min(limit, end);
            if (clippedEnd - clippedStart >= 0.001) out.push({ start: clippedStart, end: clippedEnd });
        }
        return out;
    };

    const normalizeRecord = (record) => {
        if (!record || typeof record.id !== "string" || !record.id) return null;
        if (typeof record.origin !== "string" || !record.origin) return null;
        if (typeof record.pageUrl !== "string" || !record.pageUrl) return null;
        const segments = clipSegments(record.segments);
        if (!segments.length) return null;
        return {
            id: record.id,
            savedAt: Number.isFinite(record.savedAt) ? record.savedAt : Date.now(),
            origin: record.origin,
            pageUrl: String(record.pageUrl || ""),
            pageTitle: String(record.pageTitle || ""),
            mediaUrl: String(record.mediaUrl || ""),
            mediaTitle: String(record.mediaTitle || ""),
            duration: Number.isFinite(Number(record.duration)) ? Number(record.duration) : 0,
            segments,
        };
    };

    const byNewest = (a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1);

    // 同一页面地址只留最近 5 条，整机再只留最近 200 条。空分段会删掉这条 id。
    const cap = (list) => {
        const byUrl = new Map();
        for (const item of list) {
            const bucket = byUrl.get(item.pageUrl) || [];
            bucket.push(item);
            byUrl.set(item.pageUrl, bucket);
        }
        const kept = [];
        for (const bucket of byUrl.values()) {
            bucket.sort(byNewest);
            kept.push(...bucket.slice(0, PER_URL));
        }
        kept.sort(byNewest);
        return kept.slice(0, GLOBAL);
    };

    const upsert = (list, record) => {
        const id = record && typeof record.id === "string" ? record.id : "";
        const prev = (Array.isArray(list) ? list : []).map(normalizeRecord).filter(Boolean);
        const without = prev.filter((item) => item.id !== id);
        const next = normalizeRecord(record);
        if (!next) return cap(without);
        return cap(without.concat(next));
    };

    const listFor = (list, pageUrl) => (Array.isArray(list) ? list : [])
        .map(normalizeRecord)
        .filter((item) => item && item.pageUrl === pageUrl)
        .sort(byNewest)
        .slice(0, PER_URL);

    const readAll = async () => {
        const got = await chrome.storage.local.get(KEY);
        return Array.isArray(got[KEY]) ? got[KEY] : [];
    };

    const writeAll = (list) => chrome.storage.local.set({ [KEY]: list });

    const locked = (fn) => navigator.locks?.request ? navigator.locks.request(KEY, fn) : fn();

    const api = {
        KEY,
        PER_URL,
        GLOBAL,
        freshId,
        clipSegments,
        upsert,
        listFor,
        async list(pageUrl) {
            return listFor(await readAll(), pageUrl);
        },
        async save(record) {
            await locked(async () => {
                await writeAll(upsert(await readAll(), record));
            });
        },
        async remove(id) {
            await locked(async () => {
                const next = (await readAll()).filter((item) => item && item.id !== id);
                await writeAll(next);
            });
        },
    };

    root.WmcSessions = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
