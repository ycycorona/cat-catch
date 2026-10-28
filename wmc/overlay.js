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
    let latestPlayedAt = 0;
    let followPlayback = true;
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

    const eligible = (video) => !!video?.isConnected && Number.isFinite(video.duration) && video.duration >= MIN_DURATION;
    // shortcut: 只列当前 frame 的视频；合并跨域 frame 列表时再增加汇总协议。
    const videos = () => [...document.querySelectorAll("video")].filter(eligible);
    const targetVideo = () => eligible(current?.video) ? current.video :
        eligible(latestVideo) ? latestVideo : videos().find((video) => !video.paused) || videos()[0];

    function selectVideo(video, confirmSwitch = false) {
        if (!eligible(video)) return false;
        if (current?.video === video) return true;
        if (confirmSwitch && current?.hasSegments() && !window.confirm(msg("wmc_confirmSwitchMedia"))) return false;
        current?.remove();
        current = mount(video);
        return true;
    }

    // 自动跟随保持原规则；手动选择后，其他视频播放不再抢占控制器。
    function tryMount(video) {
        if (dismissed || !followPlayback || latestVideo !== video) return;
        selectVideo(video);
    }

    document.addEventListener("play", (e) => {
        const video = e.target;
        if (!(video instanceof HTMLVideoElement)) return;
        latestVideo = video;
        latestPlayedAt = Date.now();
        if (isFinite(video.duration)) {
            tryMount(video);
        } else {
            video.addEventListener("loadedmetadata", () => tryMount(video), { once: true });
        }
    }, true);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.Message === "wmcGetOverlayState") {
            const video = targetVideo();
            sendResponse({ available: !!video, bound: eligible(current?.video), playing: !!video && !video.paused, latestPlayedAt });
            return;
        }
        if (message.Message === "wmcShowOverlay") {
            const video = targetVideo();
            if (!video || !selectVideo(video)) {
                sendResponse({ ok: false, reason: "wmc_noVideo" });
                return;
            }
            dismissed = false;
            current.show();
            sendResponse({ ok: true });
            return;
        }
        if (message.Message !== "wmcJobsChanged") return;
        jobs = message.jobs || [];
        current?.renderBadge();
    });
    chrome.runtime.sendMessage({ Message: "wmcGetJobs" }, (response) => {
        if (chrome.runtime.lastError) return;
        jobs = response?.jobs || [];
        current?.renderBadge();
    });

    for (const type of ["play", "pause", "loadedmetadata", "durationchange"]) {
        document.addEventListener(type, (event) => {
            if (event.target instanceof HTMLVideoElement) current?.renderMedia();
        }, true);
    }
    new MutationObserver(() => {
        if (current && !current.video.isConnected) {
            current.remove();
            current = null;
            followPlayback = true;
            if (!dismissed) selectVideo(targetVideo());
        }
        current?.renderMedia();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["title", "aria-label"] });

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
            .bar { position: relative; box-sizing: border-box;
                width: 100%; padding: 8px 10px; border-radius: 10px; background: rgba(17,24,39,.94);
                color: #f9fafb; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
                box-shadow: 0 6px 20px rgba(0,0,0,.35); user-select: none; }
            .identity, .controls { display: flex; align-items: center; gap: 8px; }
            .identity { padding-bottom: 7px; margin-bottom: 7px; border-bottom: 1px solid rgba(255,255,255,.08); }
            .identity label { color: #9ca3af; font-size: 11px; white-space: nowrap; }
            .media { flex: 1; min-width: 0; color-scheme: dark; font: inherit; font-size: 12px; height: 23px; }
            .media:focus-visible { outline: 2px solid #60a5fa; }
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
                <div class="identity"><label for="wmc-media"></label><select class="media" id="wmc-media"></select></div>
                <div class="controls">
                <span class="handle" aria-hidden="true">⠿</span>
                <button class="play" type="button"></button>
                <span class="time">0:00 / 0:00</span>
                <div class="track"><div class="rail"></div><div class="head"></div></div>
                <button class="add" type="button">＋</button>
                <button class="dl" type="button">↓</button>
                <span class="badge" role="status" aria-live="polite"></span>
                <button class="close" type="button">×</button>
                </div>
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
        const media = root.querySelector(".media");
        root.querySelector(".identity label").textContent = msg("wmc_currentMedia");

        let mediaVideos = [];
        let mediaSignature = "";
        const mediaName = (item, index, count) => {
            const title = item.getAttribute("aria-label")?.trim() || item.title.trim();
            if (title) return title;
            try {
                const url = new URL(item.currentSrc);
                if (["http:", "https:"].includes(url.protocol)) {
                    const name = decodeURIComponent(url.pathname.split("/").pop());
                    if (name) return name;
                }
            } catch { /* 无效来源或编码时回退为可读名称。 */ }
            return count === 1 && document.title.trim() ||
                chrome.i18n.getMessage("wmc_videoNumber", String(index + 1));
        };
        const renderMedia = () => {
            if (root.activeElement === media) return;
            const items = videos();
            const names = items.map((item, index) => mediaName(item, index, items.length));
            const labels = names.map((name, index) => {
                const item = items[index];
                const duplicate = names.indexOf(name) !== names.lastIndexOf(name);
                return `${item.paused ? "" : "▶ "}${name}${duplicate ? ` · ${index + 1}` : ""} · ${fmt(item.duration)}`;
            });
            const signature = JSON.stringify([labels, items.indexOf(video)]);
            mediaVideos = items;
            media.title = names[items.indexOf(video)] || "";
            if (signature === mediaSignature) return;
            mediaSignature = signature;
            media.replaceChildren(new Option(msg("wmc_followPlayback"), "auto"),
                ...labels.map((label, index) => new Option(label, String(index))));
            media.value = String(items.indexOf(video));
        };
        media.addEventListener("pointerdown", renderMedia);
        media.addEventListener("blur", renderMedia);
        media.addEventListener("change", () => {
            const auto = media.value === "auto";
            const target = auto ? eligible(latestVideo) ? latestVideo : video : mediaVideos[Number(media.value)];
            if (selectVideo(target, true)) followPlayback = auto;
            media.value = String(mediaVideos.indexOf(video));
        });

        play.setAttribute("aria-label", msg("wmc_play"));
        add.setAttribute("aria-label", msg("wmc_addSegment"));
        dl.setAttribute("aria-label", msg("wmc_download"));
        close.setAttribute("aria-label", msg("wmc_closeOverlay"));

        let start = null; // 待定起点
        let pendingSlot = 0;
        let capability = null; // 最近一次 wmcResolve 的结果：{ selectable, kind, reason }
        let resolveAt = 0; // 上次判定的时间，用来给重试限频
        let resolveTries = 0;
        let source = video.currentSrc;
        let sourceDuration = video.duration;
        let resolveVersion = 0;
        let resolving = false;
        const blocked = () => !capability || capability.selectable === false;
        // 「没找到播放列表」是临时结论：cacheData 会随播放继续补齐，允许限频重试；
        // 直播/加密/无 Range 是定论，不重试。
        const retryable = () => capability?.reason === "wmc_reasonUnknownSource" && resolveTries < 12;
        // [WMC] 每个媒体身份独立判定，未确认能力时禁用添加选段。
        const resolveMedia = () => {
            resolveAt = Date.now();
            resolveTries += 1;
            resolving = true;
            const version = ++resolveVersion;
            const url = video.currentSrc;
            chrome.runtime.sendMessage({
                Message: "wmcResolve",
                url,
                currentSrc: url,
                duration: video.duration,
                drm: !!video.mediaKeys,
                mediaStream: !!video.srcObject,
            }, (response) => {
                const error = chrome.runtime.lastError;
                if (signal.aborted || version !== resolveVersion || url !== video.currentSrc) return;
                resolving = false;
                capability = !error && typeof response?.selectable === "boolean" ? response :
                    { selectable: false, reason: "wmc_reasonUnknownSource" };
                showHint("");
                render();
            });
        };
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
            add.disabled = blocked() || segments.every(Boolean);
            add.title = blocked() ? msg(capability?.reason || "wmc_reasonUnknownSource")
                : add.disabled ? msg("wmc_maxSegments") : msg("wmc_addSegment");
            if (blocked()) showHint(add.title);
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
            host.style.display = "none";
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

        for (const type of ["play", "pause", "timeupdate", "seeked", "durationchange", "loadedmetadata", "emptied", "loadstart", "encrypted"]) {
            video.addEventListener(type, () => {
                const meta = type === "loadedmetadata" || type === "durationchange";
                // [WMC] 广告/正文共用 video 时丢弃旧能力、未提交选段和异步响应。
                if (source !== video.currentSrc || type === "emptied" || type === "loadstart" || type === "encrypted" ||
                    (meta && Number.isFinite(video.duration) && Math.abs(video.duration - sourceDuration) > 2)) {
                    source = video.currentSrc;
                    sourceDuration = video.duration;
                    resolveVersion += 1;
                    resolving = false;
                    capability = null;
                    resolveTries = 0;
                    start = null;
                    segments.fill(null);
                    showHint("");
                }
                if (meta) sourceDuration = video.duration;
                const retryNow = retryable() && Date.now() - resolveAt > 3000 && (meta || type === "timeupdate");
                if (!resolving && video.currentSrc && Number.isFinite(video.duration) &&
                    (!capability || retryNow)) resolveMedia();
                render();
            }, { signal });
        }
        window.addEventListener("resize", place, { signal });

        document.documentElement.appendChild(host);
        place();
        render();
        renderMedia();
        resolveMedia();
        return { video, renderBadge, renderMedia, hasSegments: () => start !== null || segments.some(Boolean),
            show: () => { host.style.display = ""; renderMedia(); place(); },
            remove: () => { events.abort(); host.remove(); } };
    }
})();
