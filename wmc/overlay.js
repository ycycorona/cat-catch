// [WMC] SPEC-001：悬浮控制器（closed shadow root，两槽选段）。不读写 G/cacheData。
(() => {
    if (window.__wmcOverlay) return;
    window.__wmcOverlay = true;

    const MIN_DURATION = 10;
    const BAR_WIDTH = 420;
    const MARGIN = 16;
    let current = null;
    let dismissed = false;
    let latestVideo = null;
    let jobs = [];

    const msg = (key) => chrome.i18n.getMessage(key);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const pct = (v, duration) => (duration > 0 ? clamp((v / duration) * 100, 0, 100) : 0);
    const fmt = (sec) => {
        const s = Math.max(0, Math.floor(sec || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = String(s % 60).padStart(2, "0");
        return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
    };

    // 只挂载播放中的长视频；短片、无 video、直播（duration 非有限值）都不建可见元素。
    function tryMount(video) {
        if (dismissed || latestVideo !== video || current?.video === video) return;
        if (!isFinite(video.duration) || video.duration < MIN_DURATION) return;
        current?.remove();
        current = mount(video);
    }

    document.addEventListener("play", (e) => {
        const video = e.target;
        if (!(video instanceof HTMLVideoElement) || dismissed) return;
        latestVideo = video;
        if (isFinite(video.duration)) {
            tryMount(video);
        } else {
            video.addEventListener("loadedmetadata", () => tryMount(video), { once: true });
        }
    }, true);

    chrome.runtime.onMessage.addListener((message) => {
        if (message.Message !== "wmcJobsChanged") return;
        jobs = message.jobs || [];
        current?.renderBadge();
    });
    chrome.runtime.sendMessage({ Message: "wmcGetJobs" }, (response) => {
        if (chrome.runtime.lastError) return;
        jobs = response?.jobs || [];
        current?.renderBadge();
    });

    function mount(video) {
        const events = new AbortController();
        const signal = events.signal;
        const host = document.createElement("div");
        host.id = "wmc-overlay";
        host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483000;";
        const root = host.attachShadow({ mode: "closed" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`
            :host { all: initial; }
            .bar { position: relative; display: flex; align-items: center; gap: 8px; box-sizing: border-box;
                width: 100%; padding: 8px 10px; border-radius: 10px; background: rgba(17,24,39,.94);
                color: #f9fafb; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
                box-shadow: 0 6px 20px rgba(0,0,0,.35); user-select: none; }
            .handle { cursor: grab; color: #9ca3af; font-size: 14px; letter-spacing: 1px; padding: 0 2px; touch-action: none; }
            button { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
                width: 24px; height: 24px; border-radius: 6px; color: #f9fafb; cursor: pointer; font-size: 13px; }
            button:hover { background: rgba(255,255,255,.14); }
            button:focus-visible { outline: 2px solid #60a5fa; }
            button:disabled { opacity: .4; cursor: not-allowed; background: none; }
            .play { width: 28px; height: 28px; background: rgba(255,255,255,.12); }
            .time { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; color: #e5e7eb; }
            .track { position: relative; flex: 1; min-width: 60px; height: 16px; display: flex; align-items: center;
                cursor: pointer; touch-action: none; }
            .rail { position: relative; width: 100%; height: 4px; border-radius: 2px; background: rgba(255,255,255,.28); }
            .seg { position: absolute; top: -9px; height: 8px; border-radius: 3px; }
            .seg.pending { opacity: .6; }
            .seg[hidden] { display: none; }
            .edge { position: absolute; top: -4px; width: 8px; height: 16px; cursor: ew-resize;
                background: rgba(255,255,255,.5); touch-action: none; }
            .edge.start { left: -4px; }
            .edge.end { right: -4px; }
            .delete { position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%);
                background: #111827; visibility: hidden; }
            .seg:hover .delete, .seg:focus-within .delete { visibility: visible; }
            .pending .edge, .pending .delete { display: none; }
            .badge { min-width: 12px; font-size: 12px; }
            .head { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px;
                border-radius: 50%; background: #fff; pointer-events: none; }
            .hint { position: absolute; left: 10px; bottom: 100%; margin-bottom: 6px; padding: 4px 8px;
                border-radius: 6px; background: #111827; color: #fde68a; font-size: 12px; white-space: nowrap;
                box-shadow: 0 4px 12px rgba(0,0,0,.35); }
            .hint:empty { display: none; }
        `);
        root.adoptedStyleSheets = [sheet];
        root.innerHTML = `
            <div class="bar">
                <span class="handle" aria-hidden="true">⠿</span>
                <button class="play" type="button"></button>
                <span class="time">0:00 / 0:00</span>
                <div class="track"><div class="rail"></div><div class="head"></div></div>
                <button class="add" type="button">＋</button>
                <button class="dl" type="button">↓</button>
                <span class="badge" role="status" aria-live="polite"></span>
                <button class="close" type="button">×</button>
                <div class="hint" role="status" aria-live="polite"></div>
            </div>`;

        const handle = root.querySelector(".handle");
        const play = root.querySelector(".play");
        const time = root.querySelector(".time");
        const track = root.querySelector(".track");
        const head = root.querySelector(".head");
        const add = root.querySelector(".add");
        const dl = root.querySelector(".dl");
        const hint = root.querySelector(".hint");
        const badge = root.querySelector(".badge");
        const close = root.querySelector(".close");

        play.setAttribute("aria-label", msg("wmc_play"));
        add.setAttribute("aria-label", msg("wmc_addSegment"));
        dl.setAttribute("aria-label", msg("wmc_download"));
        close.setAttribute("aria-label", msg("wmc_closeOverlay"));

        let start = null; // 待定起点
        let pendingSlot = 0;
        const segments = [null, null]; // 槽位固定段色，删除后复用空槽。
        const segEls = segments.map((_, index) => {
            const el = document.createElement("div");
            el.className = "seg";
            el.style.background = ["#3b82f6", "#f97316"][index];
            el.innerHTML = '<button class="edge start" type="button" role="slider"></button>' +
                '<button class="edge end" type="button" role="slider"></button>' +
                '<button class="delete" type="button">×</button>';
            const del = el.querySelector(".delete");
            del.setAttribute("aria-label", msg("wmc_deleteSegment"));
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                segments[index] = null;
                render();
            });
            for (const key of ["start", "end"]) {
                const edge = el.querySelector(`.edge.${key}`);
                edge.setAttribute("aria-label", msg(key === "start" ? "wmc_segmentStart" : "wmc_segmentEnd"));
                const adjust = (value) => {
                    const seg = segments[index];
                    if (!seg) return;
                    const next = clamp(value, 0, video.duration);
                    if (key === "start" ? next >= seg.end : next <= seg.start) return;
                    seg[key] = next;
                    render();
                };
                edge.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = track.getBoundingClientRect();
                    const move = (ev) => adjust((ev.clientX - rect.left) / rect.width * video.duration);
                    const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        window.removeEventListener("pointercancel", up);
                    };
                    window.addEventListener("pointermove", move, { signal });
                    window.addEventListener("pointerup", up, { signal });
                    window.addEventListener("pointercancel", up, { signal });
                });
                edge.addEventListener("keydown", (e) => {
                    if (!segments[index] || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
                    e.preventDefault();
                    adjust(segments[index][key] + (e.key === "ArrowLeft" ? -1 : 1));
                });
            }
            root.querySelector(".rail").append(el);
            return el;
        });

        const renderBadge = () => {
            const matching = jobs.filter((job) => job.pageUrl === location.href && job.mediaUrl === video.currentSrc);
            const count = matching.filter((job) => ["queued", "running"].includes(job.status)).length;
            const failed = matching.some((job) => ["failed", "interrupted"].includes(job.status));
            const done = matching.some((job) => job.status === "done");
            badge.textContent = count ? String(count) : failed ? "!" : done ? "✓" : "";
            badge.setAttribute("aria-label", count ? chrome.i18n.getMessage("wmc_activeDownloads", String(count)) :
                failed ? msg("wmc_statusFailed") : done ? msg("wmc_statusDone") : "");
        };

        const place = () => {
            const rect = video.getBoundingClientRect();
            const width = Math.min(BAR_WIDTH, Math.max(200, window.innerWidth - 2 * MARGIN));
            host.style.width = `${width}px`;
            const height = host.getBoundingClientRect().height || 44;
            const hasRect = rect.width > 0 && rect.height > 0;
            const left = hasRect ? rect.left + MARGIN : window.innerWidth - width - MARGIN;
            const top = hasRect ? rect.bottom - height - MARGIN : window.innerHeight - height - MARGIN;
            host.style.left = `${clamp(left, 0, window.innerWidth - width)}px`;
            host.style.top = `${clamp(top, 0, window.innerHeight - height)}px`;
        };

        const render = () => {
            const duration = isFinite(video.duration) ? video.duration : 0;
            play.textContent = video.paused ? "▶" : "❚❚";
            play.setAttribute("aria-label", video.paused ? msg("wmc_play") : msg("wmc_pause"));
            time.textContent = `${fmt(video.currentTime)} / ${fmt(duration)}`;
            head.style.left = `${pct(video.currentTime, duration)}%`;
            segEls.forEach((segEl, index) => {
                const pending = start !== null && index === pendingSlot;
                const block = pending ? { start, end: Math.max(start, Math.min(video.currentTime, duration)) } : segments[index];
                segEl.hidden = !block;
                if (!block) return;
                segEl.classList.toggle("pending", pending);
                segEl.style.left = `${pct(block.start, duration)}%`;
                segEl.style.width = `${pct(block.end, duration) - pct(block.start, duration)}%`;
                for (const key of ["start", "end"]) {
                    const edge = segEl.querySelector(`.edge.${key}`);
                    edge.setAttribute("aria-valuemin", key === "start" ? "0" : String(block.start));
                    edge.setAttribute("aria-valuemax", String(key === "start" ? block.end : duration));
                    edge.setAttribute("aria-valuenow", String(block[key]));
                }
            });
            add.disabled = segments.every(Boolean);
            add.title = add.disabled ? msg("wmc_maxSegments") : msg("wmc_addSegment");
            renderBadge();
        };

        const showHint = (text) => {
            hint.textContent = text;
        };

        play.addEventListener("click", () => {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
        });

        add.addEventListener("click", () => {
            const now = video.currentTime;
            if (start === null) {
                pendingSlot = segments.findIndex((seg) => !seg);
                if (pendingSlot < 0) return;
                start = clamp(now, 0, video.duration);
            } else if (now > start) {
                segments[pendingSlot] = { start, end: Math.min(now, video.duration) };
                start = null;
                showHint("");
            }
            // 终点 ≤ 起点：不生成选段，起点保持待定
            render();
        });

        dl.addEventListener("click", () => {
            // 待定态不提交任何下载任务
            if (start !== null) {
                showHint(msg("wmc_needEnd"));
                return;
            }
            const selected = segments.flatMap((seg, segIndex) => seg ? [{ ...seg, segIndex }] : []);
            chrome.runtime.sendMessage({
                Message: "wmcSubmit",
                url: video.currentSrc,
                pageUrl: location.href,
                pageTitle: document.title,
                segments: selected,
                duration: video.duration,
            }, (response) => {
                const error = chrome.runtime.lastError;
                if (signal.aborted) return;
                showHint(error || !response?.ok ? msg("wmc_submitFailed") :
                    selected.length ? "" : msg("wmc_wholeStarted"));
            });
        });

        close.addEventListener("click", () => {
            dismissed = true;
            current?.remove();
            current = null;
        });

        handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            const rect = host.getBoundingClientRect();
            const dx = e.clientX - rect.left;
            const dy = e.clientY - rect.top;
            const move = (ev) => {
                host.style.left = `${clamp(ev.clientX - dx, 0, window.innerWidth - rect.width)}px`;
                host.style.top = `${clamp(ev.clientY - dy, 0, window.innerHeight - rect.height)}px`;
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
            };
            window.addEventListener("pointermove", move, { signal });
            window.addEventListener("pointerup", up, { signal });
            window.addEventListener("pointercancel", up, { signal });
        });

        const seekTo = (clientX) => {
            const rect = track.getBoundingClientRect();
            if (!(rect.width > 0) || !isFinite(video.duration)) return;
            video.currentTime = clamp((clientX - rect.left) / rect.width, 0, 1) * video.duration;
        };
        track.addEventListener("pointerdown", (e) => {
            if (e.target.closest(".seg")) return;
            e.preventDefault();
            seekTo(e.clientX);
            const move = (ev) => seekTo(ev.clientX);
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
            };
            window.addEventListener("pointermove", move, { signal });
            window.addEventListener("pointerup", up, { signal });
            window.addEventListener("pointercancel", up, { signal });
        });

        for (const type of ["play", "pause", "timeupdate", "seeked", "durationchange", "loadedmetadata"]) {
            video.addEventListener(type, render, { signal });
        }
        window.addEventListener("resize", place, { signal });

        document.documentElement.appendChild(host);
        place();
        render();
        return { video, renderBadge, remove: () => { events.abort(); host.remove(); } };
    }
})();
