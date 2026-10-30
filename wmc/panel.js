// [WMC] SPEC-001 T6：任务面板——平铺列表 + 执行宿主（一次一个任务，按提交顺序）。
// [WMC] SPEC-002 T2：页签、搜索、按行更新。这一张不分组。
// 队列与状态只有一份来源：chrome.storage.local 的 wmcJobs。本文件不读写 cacheData。
(() => {
    const SEG_COLORS = ["#3b82f6", "#f97316", "#22c55e"];
    const STATUS_KEYS = {
        queued: "wmc_statusQueued",
        running: "wmc_statusRunning",
        done: "wmc_statusDone",
        failed: "wmc_statusFailed",
        canceled: "wmc_statusCanceled",
        interrupted: "wmc_statusInterrupted",
    };
    const UNFINISHED = ["queued", "running"];

    const t = (key, sub) => (sub === undefined ? chrome.i18n.getMessage(key) : chrome.i18n.getMessage(key, sub)) || key;
    const panelTitle = t("wmc_panelTitle");
    document.getElementById("wmc_title").textContent = panelTitle;
    const list = document.getElementById("wmc_clips");
    const tabsEl = document.getElementById("wmc_tabs");
    const searchEl = document.getElementById("wmc_search");
    const clearEl = document.getElementById("wmc_search_clear");
    const emptyEl = document.getElementById("wmc_empty");
    searchEl.placeholder = t("wmc_search");
    searchEl.setAttribute("aria-label", t("wmc_search"));
    clearEl.textContent = t("wmc_searchClear");
    emptyEl.textContent = t("wmc_noMatch");
    document.getElementById("wmc_note").textContent = t("wmc_panelNote");
    const TAB_KEYS = { running: "wmc_tabRunning", done: "wmc_tabDone", open: "wmc_tabOpen", all: "wmc_tabAll" };
    let tab = "all";
    let groupBy = "site";
    let collapsed = {};
    const groupEl = document.getElementById("wmc_group");
    document.getElementById("wmc_group_label").textContent = t("wmc_groupBy");
    groupEl.querySelector("[value=site]").textContent = t("wmc_groupSite");
    groupEl.querySelector("[value=page]").textContent = t("wmc_groupPage");
    groupEl.querySelector("[value=none]").textContent = t("wmc_groupNone");
    const fmt = (sec) => {
        const s = Math.max(0, Math.floor(sec || 0));
        return `${String(Math.floor(s / 60)).padStart(2, "0")}-${String(s % 60).padStart(2, "0")}`;
    };

    let jobs = [];
    let handoffs = []; // 整段交接仅有提示，不是下载任务。
    let running = null; // 当前任务的 AbortController
    let runningId = null;
    let pumping = false;

    const readJobs = async () => {
        const got = await chrome.storage.local.get("wmcJobs");
        return Array.isArray(got.wmcJobs) ? got.wmcJobs : [];
    };
    // 面板页不执行 sw.js。截断规则与那边的 wmcCapJobs 相同：排队中和下载中不删。
    const WMC_JOB_LIMIT = 300;
    const wmcCapJobs = (jobs) => {
        const kept = jobs.filter((job) => job.status === "queued" || job.status === "running");
        const ended = jobs.filter((job) => job.status !== "queued" && job.status !== "running")
            .sort((a, b) => a.createdAt - b.createdAt);
        const room = Math.max(0, WMC_JOB_LIMIT - kept.length);
        return [...kept, ...ended.slice(ended.length - room)];
    };
    const writeJobs = (next) => chrome.storage.local.set({ wmcJobs: wmcCapJobs(next) });
    const patch = (id, fields) => navigator.locks.request("wmcJobs", async () => {
        const next = (await readJobs()).map((job) => (job.id === id ? { ...job, ...fields } : job));
        await writeJobs(next);
    });
    // 进度落盘：同一任务距上次写入不足 1 秒就跳过，界面读的是内存里的最新值。
    const progressWritten = new Map();
    const patchProgress = async (id, progress) => {
        const job = jobs.find((item) => item.id === id);
        if (job && job.status === "running") {
            job.progress = progress;
            const li = rows.get(id);
            if (li) paint(li, job);
        }
        const now = Date.now();
        if (now - (progressWritten.get(id) || 0) < 1000) return;
        progressWritten.set(id, now);
        await patch(id, { progress });
    };
    // 存储里的进度可能比内存里慢一秒。同一次下载中不把界面倒回去。
    const takeJobs = (next) => {
        const prev = new Map(jobs.map((job) => [job.id, job]));
        jobs = (next || []).map((job) => {
            const old = prev.get(job.id);
            if (old && old.status === "running" && job.status === "running" && (old.progress || 0) > (job.progress || 0)) {
                return { ...job, progress: old.progress };
            }
            return job;
        });
    };

    // 主名按 UTF-8 字节封顶。200 留出 ".mp4.crdownload"，避免 Chrome 临时名顶破 255 字节。
    const FILE_NAME_BUDGET = 200;
    const utf8len = (s) => new TextEncoder().encode(s).length;
    const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/i;

    function cleanTitle(text) {
        let s = String(text || "");
        if (typeof s.toWellFormed === "function") s = s.toWellFormed();
        let kept = "";
        for (const ch of s) {
            const cp = ch.codePointAt(0);
            if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) continue;
            kept += ch;
        }
        return kept
            .replace(/\p{Cc}/gu, " ")
            .replace(/\p{Cf}/gu, "")
            .replace(/["*/:<>?\\|]/g, "-")
            .replace(/\p{White_Space}+/gu, " ");
    }

    function trimEnds(text) {
        return text.replace(/^[\p{White_Space}.~]+|[\p{White_Space}.~]+$/gu, "");
    }

    function fitTitle(title, maxBytes) {
        title = trimEnds(title);
        if (!title || maxBytes <= 0) return "";
        if (utf8len(title) <= maxBytes) return title;
        const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title)].map((g) => g.segment);
        const mark = utf8len("…");
        if (maxBytes < mark) return "";
        let head = 0;
        let tail = parts.length;
        let headBytes = 0;
        let tailBytes = 0;
        while (head < tail) {
            const takeHead = headBytes <= tailBytes;
            const piece = parts[takeHead ? head : tail - 1];
            if (headBytes + tailBytes + utf8len(piece) + mark > maxBytes) break;
            if (takeHead) { head += 1; headBytes += utf8len(piece); }
            else { tail -= 1; tailBytes += utf8len(piece); }
        }
        const left = trimEnds(parts.slice(0, head).join(""));
        const right = trimEnds(parts.slice(tail).join(""));
        if (left && right) return `${left}…${right}`;
        return left || right;
    }

    function fileClock(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(Math.floor(s / 3600))}.${pad(Math.floor((s % 3600) / 60))}.${pad(s % 60)}`;
    }

    function fileNameFor(job, out) {
        const ext = String(out.ext || "mp4").replace(/[^a-z0-9]/gi, "") || "mp4";
        const span = `${fileClock(out.actualStart)}-${fileClock(out.actualEnd)}`;
        const room = FILE_NAME_BUDGET - utf8len(span) - 1;
        const title = fitTitle(cleanTitle(job.pageTitle), room);
        let stem = title ? `${title} ${span}` : span;
        if (WINDOWS_DEVICE.test(stem.split(".")[0])) stem = `_${stem}`;
        return `${stem}.${ext}`;
    }

    async function saveDownload(url, fileName) {
        const start = (name) => chrome.downloads.download({ url, filename: name, saveAs: false });
        try {
            return { fileName, downloadId: await start(fileName) };
        } catch (e) {
            if (!/invalid filename/i.test(String((e && e.message) || e))) throw e;
            const time = String(fileName).match(/\d{2}(?:\.\d{2}){2}-\d{2}(?:\.\d{2}){2}/);
            const safe = `${time ? time[0] : "clip"}.mp4`;
            return { fileName: safe, downloadId: await start(safe) };
        }
    }

    async function run(job) {
        const ac = new AbortController();
        running = ac;
        runningId = job.id;
        await patch(job.id, { status: "running", progress: 0, error: null, startedAt: Date.now() });
        try {
            // setRequestHeaders 作用于调用方自己的标签页，所以必须在面板页设置、再在面板页 fetch。
            await new Promise((resolve) => setRequestHeaders(job.requestHeaders || {}, resolve));
            const onProgress = (p) => { patchProgress(job.id, p); };
            // HLS 用播放列表；DASH 是分开的视频、音频，按分片取再合成；其余仍是单文件 MP4。
            const out = job.kind === "hls"
                ? await WmcHlsCut.cut({
                    playlistUrl: job.sourceUrl || job.mediaUrl,
                    start: job.start,
                    end: job.end,
                    signal: ac.signal,
                    onProgress,
                })
                : job.kind === "dash"
                    ? await WmcDashCut.cut({
                        videoUrl: job.videoUrl,
                        audioUrl: job.audioUrl,
                        videoInit: job.videoInit,
                        videoIndex: job.videoIndex,
                        audioInit: job.audioInit,
                        audioIndex: job.audioIndex,
                        start: job.start,
                        end: job.end,
                        signal: ac.signal,
                        onProgress,
                    })
                    : await WmcMp4Cut.cut({
                        url: job.mediaUrl,
                        start: job.start,
                        end: job.end,
                        signal: ac.signal,
                        onProgress,
                    });
            const blobUrl = URL.createObjectURL(out.blob);
            const saved = await saveDownload(blobUrl, fileNameFor(job, out));
            setTimeout(() => URL.revokeObjectURL(blobUrl), 30000); // shortcut: 留时间给下载器读 blob，长任务可能堆积内存
            await patch(job.id, {
                status: "done",
                progress: 1,
                actualStart: out.actualStart,
                actualEnd: out.actualEnd,
                fileName: saved.fileName,
                downloadId: saved.downloadId,
            });
        } catch (e) {
            if (e && e.name === "AbortError") await patch(job.id, { status: "canceled", progress: 0 });
            else await patch(job.id, { status: "failed", error: String((e && e.message) || e) });
        } finally {
            running = null;
            runningId = null;
        }
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            for (;;) {
                const next = (await readJobs())
                    .filter((job) => job.status === "queued")
                    .sort((a, b) => a.createdAt - b.createdAt)[0];
                if (!next) break;
                await run(next);
            }
        } finally {
            pumping = false;
        }
    }

    const cancel = async (id) => {
        const job = (await readJobs()).find((item) => item.id === id);
        if (!job) return;
        if (job.status === "running" && running) running.abort();
        await patch(id, { status: "canceled", progress: 0, error: null });
    };

    const retry = async (id) => {
        await patch(id, { status: "queued", progress: 0, error: null, actualStart: null, actualEnd: null, fileName: null });
        pump();
    };
    const idsOf = (list, pred) => new Set(list.filter(pred).map((job) => job.id));
    const cancelIds = async (ids) => {
        if (runningId && ids.has(runningId) && running) running.abort();
        await navigator.locks.request("wmcJobs", async () => {
            const next = (await readJobs()).map((job) =>
                ids.has(job.id) && UNFINISHED.includes(job.status)
                    ? { ...job, status: "canceled", progress: 0, error: null } : job);
            await writeJobs(next);
        });
    };
    const retryIds = async (ids) => {
        await navigator.locks.request("wmcJobs", async () => {
            const next = (await readJobs()).map((job) =>
                ids.has(job.id) && (job.status === "failed" || job.status === "interrupted")
                    ? { ...job, status: "queued", progress: 0, error: null, actualStart: null, actualEnd: null, fileName: null }
                    : job);
            await writeJobs(next);
        });
        pump();
    };
    const clearDone = async (ids) => {
        await navigator.locks.request("wmcJobs", async () => {
            const next = (await readJobs()).filter((job) => !(ids.has(job.id) && job.status === "done"));
            await writeJobs(next);
        });
    };
    const removeJob = async (id) => {
        await navigator.locks.request("wmcJobs", async () => {
            const next = (await readJobs()).filter((job) => job.id !== id);
            await writeJobs(next);
        });
    };

    const button = (label, onClick) => {
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = label;
        el.addEventListener("click", onClick);
        return el;
    };

    const rows = new Map();
    let structure = "";
    const rowId = (job) => String(job.id || job.openedUrl || job.createdAt);
    const siteName = (url) => {
        try { return new URL(url).hostname.replace(/^www\./i, ""); }
        catch { return ""; }
    };
    const inTab = (status, which) => which === "all" ||
        (which === "running" && UNFINISHED.includes(status)) ||
        (which === "done" && status === "done") ||
        (which === "open" && (status === "failed" || status === "interrupted" || status === "canceled"));
    const siteLabel = (url) => siteName(url) || t("wmc_groupOther");
    const matchesQuery = (job, q) => {
        if (!q) return true;
        return [job.pageTitle, siteLabel(job.pageUrl), job.fileName].join("\n").toLowerCase().includes(q);
    };
    const pathTail = (url) => {
        try {
            const tail = new URL(url).pathname.split("/").filter(Boolean).pop();
            return tail ? decodeURIComponent(tail) : "";
        } catch { return ""; }
    };
    const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    const mediaKey = (job) => job.sourceUrl || job.mediaUrl || job.openedUrl || job.pageUrl || "";
    const groupKey = (job) => groupBy === "page" ? (job.pageUrl || "") : (siteName(job.pageUrl) || "\0other");
    const foldKey = (key) => `${groupBy}\n${key}`;
    // 筛选后的条目再分组。空组不会出现，所以筛选后没有行的组头不画。
    function group(items) {
        const buckets = new Map();
        for (const job of items) {
            const key = groupKey(job);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(job);
        }
        return [...buckets.entries()].map(([key, list]) => {
            list.sort(byNewest);
            const medias = new Map();
            for (const job of list) {
                const mk = mediaKey(job);
                if (!medias.has(mk)) medias.set(mk, []);
                medias.get(mk).push(job);
            }
            const media = [...medias.entries()].map(([mk, rowsIn]) => {
                rowsIn.sort(byNewest);
                return { key: mk, jobs: rowsIn };
            }).sort((a, b) => byNewest(a.jobs[0], b.jobs[0]));
            return { key, jobs: list, media, latest: list[0].createdAt || 0 };
        }).sort((a, b) => b.latest - a.latest);
    }
    function groupLabel(entry) {
        if (groupBy === "site") return entry.key === "\0other" ? t("wmc_groupOther") : entry.key;
        return entry.jobs[0].pageTitle || entry.key || t("wmc_groupOther");
    }
    function mediaLabel(entry) {
        return entry.jobs[0].pageTitle || pathTail(entry.key) || t("wmc_groupOther");
    }

    function setActions(li, job, kind) {
        if (li.dataset.kind === kind) return;
        li.dataset.kind = kind;
        const actions = li.querySelector(".actions");
        actions.textContent = "";
        if (kind === "cancel") actions.append(button(t("wmc_cancel"), () => cancel(job.id)));
        else if (kind === "retry") {
            actions.append(button(t("wmc_retry"), () => retry(job.id)));
            actions.append(button(t("wmc_delete"), () => removeJob(job.id)));
        } else if (kind === "file") {
            actions.append(button(t("wmc_openFile"), () => chrome.downloads.open(job.downloadId)));
            actions.append(button(t("wmc_showFile"), () => chrome.downloads.show(job.downloadId)));
        }
    }
    const fileInfo = new Map();
    const clock = (ms) => {
        const s = Math.max(0, Math.floor(ms / 1000));
        const pad = (n) => String(n).padStart(2, "0");
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
    };
    const sizeText = (bytes) => {
        if (!Number.isFinite(bytes)) return "";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    };
    const queuePlace = (job) => jobs.filter((item) => item.status === "queued")
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .findIndex((item) => item.id === job.id) + 1;
    function wantFile(job) {
        if (job.downloadId == null || fileInfo.has(job.downloadId)) return;
        fileInfo.set(job.downloadId, { pending: true });
        chrome.downloads.search({ id: job.downloadId }).then((items) => {
            const item = items && items[0];
            fileInfo.set(job.downloadId, item ? { fileSize: item.fileSize, exists: item.exists } : { missing: true });
            const li = rows.get(job.id);
            const current = jobs.find((item) => item.id === job.id);
            if (li && current) paint(li, current);
        }).catch(() => fileInfo.set(job.downloadId, { missing: true }));
    }

    function paint(li, job) {
        li.querySelector(".title").textContent = job.pageTitle || job.pageUrl || "";
        const range = li.querySelector(".range");
        const status = li.querySelector(".status");
        const color = li.querySelector(".color");
        const bar = li.querySelector(".bar");
        const file = li.querySelector(".file");
        if (job.openedUrl) {
            color.style.background = "#9ca3af";
            range.textContent = t("wmc_wholeHandoff");
            status.textContent = "";
            status.classList.remove("error");
            bar.hidden = true;
            file.hidden = true;
            setActions(li, job, "none");
            return;
        }
        const seg = Number.isInteger(job.segIndex) ? job.segIndex : 0;
        color.style.background = SEG_COLORS[seg % SEG_COLORS.length];
        range.textContent =
            `${t("wmc_userRange")} ${fmt(job.start)}–${fmt(job.end)}` +
            (job.actualStart === null || job.actualStart === undefined
                ? ""
                : ` · ${t("wmc_actualRange")} ${fmt(job.actualStart)}–${fmt(job.actualEnd)}`);
        const pct = Math.round((job.progress || 0) * 100);
        let line = job.status === "queued" ? t("wmc_queuePos", String(queuePlace(job)))
            : job.status === "running" ? `${t("wmc_statusRunning")} ${pct}%` + runningTimes(job)
            : t(STATUS_KEYS[job.status] || "wmc_statusFailed");
        if (job.error) line += ` · ${job.error}`;
        status.classList.toggle("error", !!job.error);
        status.textContent = line;
        bar.hidden = job.status !== "running";
        bar.setAttribute("aria-valuenow", String(pct));
        bar.querySelector("span").style.width = `${pct}%`;
        const kind = UNFINISHED.includes(job.status) ? "cancel" : job.status === "done" ? "file" : "retry";
        setActions(li, job, kind);
        if (job.status === "done") {
            file.hidden = false;
            wantFile(job);
            const info = job.downloadId == null ? null : fileInfo.get(job.downloadId);
            const gone = job.downloadId == null || !!(info && !info.pending && (info.missing || info.exists === false));
            const bits = [job.fileName || ""];
            if (info && Number.isFinite(info.fileSize)) bits.push(sizeText(info.fileSize));
            if (gone) bits.push(t("wmc_fileGone"));
            file.textContent = bits.filter(Boolean).join(" · ");
            for (const btn of li.querySelectorAll(".actions button")) btn.disabled = gone;
        } else file.hidden = true;
    }
    function runningTimes(job) {
        if (!job.startedAt) return "";
        const elapsed = Date.now() - job.startedAt;
        let text = ` · ${t("wmc_elapsed", clock(elapsed))}`;
        if ((job.progress || 0) >= 0.05) text += ` · ${t("wmc_eta", clock(elapsed / job.progress * (1 - job.progress)))}`;
        return text;
    }

    function ensureRow(job) {
        const id = rowId(job);
        let li = rows.get(id);
        if (!li) {
            li = document.createElement("li");
            li.dataset.id = id;
            const color = document.createElement("span");
            color.className = "color";
            const main = document.createElement("div");
            main.className = "main";
            const title = document.createElement("div");
            title.className = "title";
            const range = document.createElement("div");
            range.className = "meta range";
            const status = document.createElement("div");
            status.className = "meta status";
            const bar = document.createElement("div");
            bar.className = "bar";
            bar.setAttribute("role", "progressbar");
            bar.setAttribute("aria-valuemin", "0");
            bar.setAttribute("aria-valuemax", "100");
            bar.append(document.createElement("span"));
            const file = document.createElement("div");
            file.className = "file";
            const actions = document.createElement("div");
            actions.className = "actions";
            main.append(title, range, status, bar, file);
            li.append(color, main, actions);
            rows.set(id, li);
        }
        paint(li, job);
        return li;
    }

    function visibleItems(q) {
        const items = [];
        for (const job of jobs) {
            if (!inTab(job.status, tab) || !matchesQuery(job, q)) continue;
            items.push(job);
        }
        if (tab === "all") {
            for (const job of handoffs) if (matchesQuery(job, q)) items.push(job);
        }
        items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return items;
    }

    function groupHead(entry) {
        const head = document.createElement("li");
        head.className = "group-head";
        head.dataset.group = entry.key;
        const open = !collapsed[foldKey(entry.key)];
        const fold = document.createElement("button");
        fold.type = "button";
        fold.className = "fold";
        fold.setAttribute("aria-expanded", open ? "true" : "false");
        fold.setAttribute("aria-label", t("wmc_fold"));
        fold.textContent = open ? "▾" : "▸";
        fold.addEventListener("click", () => {
            const key = foldKey(entry.key);
            if (collapsed[key]) delete collapsed[key];
            else collapsed[key] = true;
            chrome.storage.local.set({ wmcPanelCollapsed: collapsed });
            render();
        });
        const name = document.createElement("span");
        name.className = "group-name";
        name.textContent = groupLabel(entry);
        const real = entry.jobs.filter((job) => job.status);
        const done = real.filter((job) => job.status === "done").length;
        const ratio = document.createElement("span");
        ratio.className = "ratio";
        ratio.textContent = real.length ? t("wmc_groupRatio", [String(done), String(real.length)]) : "";
        const meter = document.createElement("span");
        meter.className = "meter";
        const fill = document.createElement("span");
        fill.style.width = real.length ? `${Math.round(done / real.length * 100)}%` : "0";
        meter.append(fill);
        if (!real.length) meter.hidden = true;
        const actions = document.createElement("span");
        actions.className = "actions";
        if (real.some((job) => UNFINISHED.includes(job.status))) {
            actions.append(button(t("wmc_cancelOpen"), () => cancelIds(idsOf(real, (job) => UNFINISHED.includes(job.status)))));
        }
        if (real.some((job) => job.status === "failed" || job.status === "interrupted")) {
            actions.append(button(t("wmc_retryFailed"), () => retryIds(idsOf(real, (job) => job.status === "failed" || job.status === "interrupted"))));
        }
        if (done) actions.append(button(t("wmc_clearDone"), () => clearDone(idsOf(real, (job) => job.status === "done"))));
        head.append(fold, name, ratio, meter, actions);
        return head;
    }
    function mediaHead(entry) {
        const head = document.createElement("li");
        head.className = "media-head";
        const name = document.createElement("span");
        name.className = "media-name";
        name.textContent = mediaLabel(entry);
        head.append(name);
        const page = entry.jobs[0].pageUrl;
        if (page) {
            head.append(button(t("wmc_openSource"), () => chrome.tabs.create({ url: page, active: false })));
        }
        return head;
    }

    function render() {
        const q = searchEl.value.trim().toLowerCase();
        clearEl.hidden = q.length === 0;
        const items = visibleItems(q);
        const folds = Object.keys(collapsed).filter((key) => collapsed[key]).sort().join("\0");
        const sig = items.map((job) => `${rowId(job)}:${job.status || ""}`).join("\0");
        const key = `${tab}\0${q}\0${groupBy}\0${folds}\0${sig}`;
        if (key !== structure) {
            structure = key;
            const frag = document.createDocumentFragment();
            if (groupBy === "none") {
                for (const job of items) frag.appendChild(ensureRow(job));
            } else {
                for (const entry of group(items)) {
                    frag.appendChild(groupHead(entry));
                    if (collapsed[foldKey(entry.key)]) continue;
                    for (const media of entry.media) {
                        frag.appendChild(mediaHead(media));
                        for (const job of media.jobs) frag.appendChild(ensureRow(job));
                    }
                }
            }
            list.replaceChildren(frag);
        } else {
            for (const job of items) paint(rows.get(rowId(job)), job);
        }
        const live = new Set([...jobs, ...handoffs].map(rowId));
        for (const id of rows.keys()) if (!live.has(id)) rows.delete(id);
        for (const btn of tabsEl.querySelectorAll("[role=tab]")) {
            const which = btn.dataset.tab;
            const count = which === "all"
                ? jobs.length + handoffs.length
                : jobs.filter((job) => inTab(job.status, which)).length;
            btn.textContent = t(TAB_KEYS[which], String(count));
            btn.setAttribute("aria-selected", which === tab ? "true" : "false");
        }
        const done = jobs.filter((job) => job.status === "done").length;
        document.title = jobs.length ? `(${done}/${jobs.length}) ${panelTitle}` : panelTitle;
        const filteredEmpty = items.length === 0 && (q !== "" || tab !== "all" || jobs.length + handoffs.length > 0);
        emptyEl.hidden = !filteredEmpty;
    }

    tabsEl.addEventListener("click", (event) => {
        const btn = event.target.closest("[role=tab]");
        if (!btn) return;
        tab = btn.dataset.tab;
        render();
    });
    groupEl.addEventListener("change", () => {
        groupBy = groupEl.value;
        chrome.storage.local.set({ wmcPanelGroupBy: groupBy });
        render();
    });
    searchEl.addEventListener("input", () => render());
    clearEl.addEventListener("click", () => {
        searchEl.value = "";
        searchEl.focus();
        render();
    });

    // 有未完成任务时关闭面板要确认；关闭后由 sw.js 的 tabs.onRemoved 把它们标为已中断。
    window.addEventListener("beforeunload", (e) => {
        if (!jobs.some((job) => UNFINISHED.includes(job.status))) return;
        e.preventDefault();
        e.returnValue = t("wmc_leaveConfirm");
    });

    (async () => {
        const prefs = await chrome.storage.local.get(["wmcPanelGroupBy", "wmcPanelCollapsed"]);
        if (["site", "page", "none"].includes(prefs.wmcPanelGroupBy)) groupBy = prefs.wmcPanelGroupBy;
        if (prefs.wmcPanelCollapsed && typeof prefs.wmcPanelCollapsed === "object") collapsed = prefs.wmcPanelCollapsed;
        groupEl.value = groupBy;
        chrome.storage.local.onChanged.addListener((changes) => {
            let paint = false;
            if (changes.wmcPanelGroupBy && ["site", "page", "none"].includes(changes.wmcPanelGroupBy.newValue)) {
                groupBy = changes.wmcPanelGroupBy.newValue;
                groupEl.value = groupBy;
                paint = true;
            }
            if (changes.wmcPanelCollapsed) {
                collapsed = changes.wmcPanelCollapsed.newValue || {};
                paint = true;
            }
            if (changes.wmcJobs) {
                takeJobs(changes.wmcJobs.newValue || []);
                paint = true;
                if (jobs.some((job) => job.status === "queued")) pump();
            }
            if (paint) render();
        });
        chrome.storage.session.onChanged.addListener((changes) => {
            if (!changes.wmcHandoffs) return;
            handoffs = changes.wmcHandoffs.newValue || [];
            render();
        });
        // 提交先把任务写成排队，再打开面板。排队的要接着跑。
        // 只有上次面板关掉时还停在下载中的，才标成已中断。
        await navigator.locks.request("wmcJobs", async () => {
            const stored = await readJobs();
            if (stored.some((job) => job.status === "running")) {
                await writeJobs(stored.map((job) =>
                    job.status === "running" ? { ...job, status: "interrupted", progress: 0 } : job));
            }
        });
        jobs = await readJobs();
        handoffs = (await chrome.storage.session.get("wmcHandoffs")).wmcHandoffs || [];
        render();
        pump();
        setInterval(() => {
            for (const job of jobs) {
                if (job.status !== "running") continue;
                const li = rows.get(job.id);
                if (li) paint(li, job);
            }
        }, 1000);
    })();
})();
