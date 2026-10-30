// 分段会话：每个网站最多 10 条。同一条会话反复编辑会覆盖自己，不会占新名额。
// shortcut: 多标签同时改同一条时后写入的那次为准；不做逐次撤销。要保留编辑历史再改成快照。
(function (root) {
    const KEY = "wmcClipSessions";
    const LIMIT = 10;

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

    // 空分段会删掉这条 id。其他网站的记录留着。
    const upsert = (list, record) => {
        const id = record && typeof record.id === "string" ? record.id : "";
        const prev = (Array.isArray(list) ? list : []).map(normalizeRecord).filter(Boolean);
        const without = prev.filter((item) => item.id !== id);
        const next = normalizeRecord(record);
        if (!next) return without;
        const same = without.filter((item) => item.origin === next.origin);
        const other = without.filter((item) => item.origin !== next.origin);
        same.push(next);
        same.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
        return other.concat(same.slice(0, LIMIT));
    };

    const listFor = (list, origin) => (Array.isArray(list) ? list : [])
        .map(normalizeRecord)
        .filter((item) => item && item.origin === origin)
        .sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1))
        .slice(0, LIMIT);

    const readAll = async () => {
        const got = await chrome.storage.local.get(KEY);
        return Array.isArray(got[KEY]) ? got[KEY] : [];
    };

    const writeAll = (list) => chrome.storage.local.set({ [KEY]: list });

    const locked = (fn) => navigator.locks?.request ? navigator.locks.request(KEY, fn) : fn();

    const api = {
        KEY,
        LIMIT,
        freshId,
        clipSegments,
        upsert,
        listFor,
        async list(origin) {
            return listFor(await readAll(), origin);
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
