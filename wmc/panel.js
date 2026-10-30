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
    const TAB_KEYS = { running: "wmc_tabRunning", done: "wmc_tabDone", open: "wmc_tabOpen", all: "wmc_tabAll" };
    let tab = "all";
    const fmt = (sec) => {
        const s = Math.max(0, Math.floor(sec || 0));
        return `${String(Math.floor(s / 60)).padStart(2, "0")}-${String(s % 60).padStart(2, "0")}`;
    };

    let jobs = [];
    let handoffs = []; // 整段交接仅有提示，不是下载任务。
    let running = null; // 当前任务的 AbortController
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
        try {
            await chrome.downloads.download({ url, filename: fileName, saveAs: false });
            return fileName;
        } catch (e) {
            if (!/invalid filename/i.test(String((e && e.message) || e))) throw e;
            const time = String(fileName).match(/\d{2}(?:\.\d{2}){2}-\d{2}(?:\.\d{2}){2}/);
            const safe = `${time ? time[0] : "clip"}.mp4`;
            await chrome.downloads.download({ url, filename: safe, saveAs: false });
            return safe;
        }
    }

    async function run(job) {
        const ac = new AbortController();
        running = ac;
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
            const fileName = await saveDownload(blobUrl, fileNameFor(job, out));
            setTimeout(() => URL.revokeObjectURL(blobUrl), 30000); // shortcut: 留时间给下载器读 blob，长任务可能堆积内存
            await patch(job.id, {
                status: "done",
                progress: 1,
                actualStart: out.actualStart,
                actualEnd: out.actualEnd,
                fileName,
            });
        } catch (e) {
            if (e && e.name === "AbortError") await patch(job.id, { status: "canceled", progress: 0 });
            else await patch(job.id, { status: "failed", error: String((e && e.message) || e) });
        } finally {
            running = null;
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
    const matchesQuery = (job, q) => {
        if (!q) return true;
        return [job.pageTitle, siteName(job.pageUrl), job.fileName].join("\n").toLowerCase().includes(q);
    };

    function setActions(li, job, kind) {
        if (li.dataset.kind === kind) return;
        li.dataset.kind = kind;
        const actions = li.querySelector(".actions");
        actions.textContent = "";
        if (kind === "cancel") actions.append(button(t("wmc_cancel"), () => cancel(job.id)));
        else if (kind === "retry") actions.append(button(t("wmc_retry"), () => retry(job.id)));
    }

    function paint(li, job) {
        li.querySelector(".title").textContent = job.pageTitle || job.pageUrl || "";
        const range = li.querySelector(".range");
        const status = li.querySelector(".status");
        const color = li.querySelector(".color");
        if (job.openedUrl) {
            color.style.background = "#9ca3af";
            range.textContent = t("wmc_wholeHandoff");
            status.textContent = "";
            status.classList.remove("error");
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
        status.classList.toggle("error", !!job.error);
        status.textContent =
            t(STATUS_KEYS[job.status] || "wmc_statusFailed") +
            (job.status === "running" ? ` ${Math.round((job.progress || 0) * 100)}%` : "") +
            (job.error ? ` · ${job.error}` : "");
        const kind = UNFINISHED.includes(job.status) ? "cancel" : job.status === "done" ? "none" : "retry";
        setActions(li, job, kind);
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
            const actions = document.createElement("div");
            actions.className = "actions";
            main.append(title, range, status);
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

    function render() {
        const q = searchEl.value.trim().toLowerCase();
        clearEl.hidden = q.length === 0;
        const items = visibleItems(q);
        const key = `${tab}\0${q}\0${items.map(rowId).join("\0")}`;
        if (key !== structure) {
            structure = key;
            const frag = document.createDocumentFragment();
            for (const job of items) frag.appendChild(ensureRow(job));
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
        chrome.storage.local.onChanged.addListener((changes) => {
            if (!changes.wmcJobs) return;
            takeJobs(changes.wmcJobs.newValue || []);
            render();
            if (jobs.some((job) => job.status === "queued")) pump();
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
    })();
})();
