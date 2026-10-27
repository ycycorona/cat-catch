// [WMC] SPEC-001 T6：任务面板——平铺列表 + 执行宿主（一次一个任务，按提交顺序）。
// 队列与状态只有一份来源：chrome.storage.session 的 wmcJobs。本文件不读写 cacheData。
(() => {
    const SEG_COLORS = ["#3b82f6", "#f97316"];
    const STATUS_KEYS = {
        queued: "wmc_statusQueued",
        running: "wmc_statusRunning",
        done: "wmc_statusDone",
        failed: "wmc_statusFailed",
        canceled: "wmc_statusCanceled",
        interrupted: "wmc_statusInterrupted",
    };
    const UNFINISHED = ["queued", "running"];

    const t = (key) => chrome.i18n.getMessage(key) || key;
    document.getElementById("wmc_title").textContent = t("wmc_panelTitle");
    const list = document.getElementById("wmc_clips");
    const fmt = (sec) => {
        const s = Math.max(0, Math.floor(sec || 0));
        return `${String(Math.floor(s / 60)).padStart(2, "0")}-${String(s % 60).padStart(2, "0")}`;
    };

    let jobs = [];
    let handoffs = []; // 整段交接仅有提示，不是下载任务。
    let running = null; // 当前任务的 AbortController
    let pumping = false;

    const readJobs = async () => {
        const got = await chrome.storage.session.get("wmcJobs");
        return Array.isArray(got.wmcJobs) ? got.wmcJobs : [];
    };
    const writeJobs = (next) => chrome.storage.session.set({ wmcJobs: next });
    const patch = (id, fields) => navigator.locks.request("wmcJobs", async () => {
        const next = (await readJobs()).map((job) => (job.id === id ? { ...job, ...fields } : job));
        await writeJobs(next);
    });
    // 进度按整百分点落盘，避免每个 Range 批次都写一次 storage。
    const patchProgress = async (id, progress) => {
        const job = (await readJobs()).find((item) => item.id === id);
        if (!job || Math.round(job.progress * 100) === Math.round(progress * 100)) return;
        await patch(id, { progress });
    };

    function fileNameFor(job, out) {
        const base = String(job.pageTitle || "clip")
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "clip";
        return `${base}_${fmt(out.actualStart)}-${fmt(out.actualEnd)}.${out.ext || "mp4"}`;
    }

    async function run(job) {
        const ac = new AbortController();
        running = ac;
        await patch(job.id, { status: "running", progress: 0, error: null });
        try {
            // setRequestHeaders 作用于调用方自己的标签页，所以必须在面板页设置、再在面板页 fetch。
            await new Promise((resolve) => setRequestHeaders(job.requestHeaders || {}, resolve));
            const onProgress = (p) => { patchProgress(job.id, p); };
            // HLS 走独立模块（blob: 源用提交时记下的播放列表地址），MP4 路径不变。
            const out = job.kind === "hls"
                ? await WmcHlsCut.cut({
                    playlistUrl: job.sourceUrl || job.mediaUrl,
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
            const fileName = fileNameFor(job, out);
            await chrome.downloads.download({ url: blobUrl, filename: fileName, saveAs: false });
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

    function row(job) {
        const li = document.createElement("li");
        const color = document.createElement("span");
        color.className = "color";
        color.style.background = SEG_COLORS[job.segIndex % SEG_COLORS.length];
        const main = document.createElement("div");
        main.className = "main";
        const title = document.createElement("div");
        title.className = "title";
        title.textContent = job.pageTitle || job.pageUrl;
        const range = document.createElement("div");
        range.className = "meta";
        if (job.openedUrl) {
            color.style.background = "#9ca3af";
            range.textContent = t("wmc_wholeHandoff");
            main.append(title, range);
            li.append(color, main);
            return li;
        }
        range.textContent =
            `${t("wmc_userRange")} ${fmt(job.start)}–${fmt(job.end)}` +
            (job.actualStart === null || job.actualStart === undefined
                ? ""
                : ` · ${t("wmc_actualRange")} ${fmt(job.actualStart)}–${fmt(job.actualEnd)}`);
        const status = document.createElement("div");
        status.className = job.error ? "meta error" : "meta";
        status.textContent =
            t(STATUS_KEYS[job.status] || "wmc_statusFailed") +
            (job.status === "running" ? ` ${Math.round((job.progress || 0) * 100)}%` : "") +
            (job.error ? ` · ${job.error}` : "");
        main.append(title, range, status);
        const actions = document.createElement("div");
        actions.className = "actions";
        if (UNFINISHED.includes(job.status)) actions.append(button(t("wmc_cancel"), () => cancel(job.id)));
        else if (job.status !== "done") actions.append(button(t("wmc_retry"), () => retry(job.id)));
        li.append(color, main, actions);
        return li;
    }

    function render() {
        list.textContent = "";
        for (const job of [...jobs, ...handoffs].sort((a, b) => b.createdAt - a.createdAt)) list.appendChild(row(job));
    }

    // 有未完成任务时关闭面板要确认；关闭后由 sw.js 的 tabs.onRemoved 把它们标为已中断。
    window.addEventListener("beforeunload", (e) => {
        if (!jobs.some((job) => UNFINISHED.includes(job.status))) return;
        e.preventDefault();
        e.returnValue = t("wmc_leaveConfirm");
    });

    (async () => {
        chrome.storage.session.onChanged.addListener((changes) => {
            if (!changes.wmcJobs && !changes.wmcHandoffs) return;
            if (changes.wmcJobs) jobs = changes.wmcJobs.newValue || [];
            if (changes.wmcHandoffs) handoffs = changes.wmcHandoffs.newValue || [];
            render();
            if (jobs.some((job) => job.status === "queued")) pump();
        });
        jobs = await readJobs();
        handoffs = (await chrome.storage.session.get("wmcHandoffs")).wmcHandoffs || [];
        render();
        pump();
    })();
})();
