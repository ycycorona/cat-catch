// [WMC] 悬浮控制器：简洁/标准视图共用选段与下载状态。不读写 G/cacheData。
(() => {
    if (window.__wmcOverlay) return;
    window.__wmcOverlay = true;

    const MIN_DURATION = 10;
    const COMPACT_MAX_W = 840;
    const COMPACT_MIN_W = 680;
    const COMPACT_SINGLE_MIN = 760;
    const COMPACT_SINGLE_H = 82;
    const COMPACT_DOUBLE_H = 120;
    const SEG_COLORS = ["#3b82f6", "#f97316", "#22c55e"];
    const MARGIN = 16;
    let current = null;
    let dismissed = false;
    let latestVideo = null;
    let latestPlayedAt = 0;
    let followPlayback = true;
    let autoShow = false;
    let standardView = false;
    const sizes = { compact: { width: COMPACT_SINGLE_MIN, height: COMPACT_SINGLE_H }, standard: { width: 760, height: 420 } };
    let jobs = [];

    chrome.storage.local.get({ wmcAutoShow: false }, (settings) => {
        if (!chrome.runtime.lastError) autoShow = settings.wmcAutoShow === true;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.wmcAutoShow) autoShow = changes.wmcAutoShow.newValue === true;
    });

    const msg = (key) => chrome.i18n.getMessage(key);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const pct = (v, duration) => (duration > 0 ? clamp((v / duration) * 100, 0, 100) : 0);
    const fmt = (sec, hours = sec >= 3600) => {
        const s = Math.max(0, Math.floor(sec || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = String(s % 60).padStart(2, "0");
        return `${hours ? String(h).padStart(2, "0") + ":" : ""}${String(m).padStart(2, "0")}:${ss}`;
    };
    const stamp = (sec) => {
        const ms = Math.max(0, Math.round(sec * 1000));
        return `${fmt(Math.floor(ms / 1000), true)}.${String(ms % 1000).padStart(3, "0")}`;
    };
    const parseStamp = (text) => {
        const parts = /^(\d{2,}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(text.trim());
        return parts ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) +
            Number((parts[4] || "").padEnd(3, "0")) / 1000 : NaN;
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
        if (dismissed || !followPlayback || (!autoShow && !current) || latestVideo !== video) return;
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
                width: 100%; height: 100%; padding: 8px 10px; border-radius: 10px; background: rgba(17,24,39,.94);
                color: #f9fafb; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
                box-shadow: 0 6px 20px rgba(0,0,0,.35); user-select: none; }
            .identity, .controls { display: flex; align-items: center; gap: 6px; }
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
            .time { flex-shrink: 0; font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
                font-variant-numeric: tabular-nums; white-space: nowrap; color: #e5e7eb; }
            .track { position: relative; flex: 1; min-width: 28px; height: 16px; display: flex; align-items: center;
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
            .badge:empty { display: none; }
            .head { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px;
                border-radius: 50%; background: #fff; pointer-events: none; }
            .hint { position: absolute; left: 10px; bottom: 100%; margin-bottom: 6px; padding: 4px 8px;
                border-radius: 6px; background: #111827; color: #fde68a; font-size: 12px; white-space: nowrap;
                box-shadow: 0 4px 12px rgba(0,0,0,.35); }
            .hint:empty { display: none; }
            .editor, .ticks, .editor-footer { display: none; }
            .bar.standard { display: flex; flex-direction: column; }
            .standard .controls { flex: none; flex-wrap: wrap; }
            .standard .track { flex: 0 0 100%; order: 10; height: 64px; margin: 9px 0 0; }
            .standard .rail { height: 6px; }
            .standard .seg { top: -10px; height: 24px; border: 1px solid rgba(255,255,255,.35); box-sizing: border-box; }
            .standard .edge { top: 1px; height: 20px; width: 6px; }
            .standard .edge.start { left: 0; } .standard .edge.end { right: 0; }
            .standard .head { z-index: 2; }
            .ticks { position: absolute; bottom: 0; left: 0; right: 0; justify-content: space-between;
                pointer-events: none; color: #9ca3af; font: 10px ui-monospace, Consolas, monospace; }
            .standard .ticks { display: flex; }
            .add-wrap { position: relative; display: flex; }
            .add.is-disabled { opacity: .4; cursor: not-allowed; background: none; }
            .add.is-disabled:hover { background: none; }
            .poptip { display: none; position: absolute; z-index: 6; left: 50%; bottom: calc(100% + 8px);
                transform: translateX(-50%); padding: 4px 8px; border-radius: 6px; background: #111827;
                color: #fde68a; font-size: 12px; line-height: 1.4; white-space: nowrap; pointer-events: none;
                box-shadow: 0 4px 12px rgba(0, 0, 0, .35); }
            .poptip::after { content: ""; position: absolute; left: 50%; top: 100%; transform: translateX(-50%);
                border: 5px solid transparent; border-top-color: #111827; }
            .bar[data-tip] .poptip:not(:empty) { display: block; }
            .standard .add-wrap { margin-left: auto; }
            .standard .add { width: auto; padding: 0 8px; border: 1px solid #475569; }
            .standard .editor { display: block; overflow: auto; flex: 1; min-height: 0; margin-top: 14px; }
            .editor-header, .clip-row { display: grid; grid-template-columns: 25px minmax(128px,1fr) minmax(128px,1fr) 95px 52px;
                gap: 8px; align-items: center; min-width: 500px; }
            .editor-header { color: #9ca3af; font-size: 11px; padding: 0 6px 8px; }
            .clip-row { padding: 11px 6px; border-top: 1px solid rgba(255,255,255,.07); }
            .clip-number { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 5px; }
            .clip-row input { box-sizing: border-box; width: 100%; min-width: 0; height: 31px; padding: 4px 6px;
                color: #f1f5f9; background: #121d2c; border: 1px solid #52637a; border-radius: 4px;
                font: 12px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
            .clip-row input:focus-visible { outline: 2px solid #60a5fa; }
            .clip-row input[aria-invalid=true] { border-color: #fb7185; background: #3b2432; }
            .clip-duration { color: #b3c2d7; font: 11px ui-monospace, Consolas, monospace; }
            .clip-actions { display: flex; gap: 3px; }
            .standard .editor-footer { display: flex; align-items: center; justify-content: space-between;
                flex: none; gap: 8px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.1); }
            .summary { font-size: 11px; color: #9ca3af; }
            .editor-footer .dl { width: auto; padding: 5px 10px; background: #2563eb; }
            .bar.roomy:not(.standard) .controls { flex-wrap: wrap; }
            .bar.roomy:not(.standard) .track { flex: 0 0 100%; order: 10; height: 28px; }
            .bar.roomy:not(.standard) .controls { position: absolute; left: 10px; right: 10px; bottom: 8px; }
            .bar.roomy:not(.standard) .add-wrap { margin-left: auto; }
            .resize { position: absolute; touch-action: none; z-index: 4; }
            .resize.n, .resize.s { height: 8px; left: 10px; right: 10px; cursor: ns-resize; }
            .resize.n { top: -4px; } .resize.s { bottom: -4px; }
            .resize.e, .resize.w { width: 8px; top: 10px; bottom: 10px; cursor: ew-resize; }
            .resize.e { right: -4px; } .resize.w { left: -4px; }
            .resize.ne, .resize.nw, .resize.se, .resize.sw { width: 12px; height: 12px; }
            .resize.ne { top: -6px; right: -6px; cursor: nesw-resize; }
            .resize.nw { top: -6px; left: -6px; cursor: nwse-resize; }
            .resize.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
            .resize.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
            .resize:focus-visible { outline: 2px solid #60a5fa; }
            .bar:hover { outline: 1px solid rgba(147,197,253,.5); }
            .resize.se::after { content: ""; position: absolute; right: 5px; bottom: 5px; width: 6px; height: 6px;
                border-right: 1px solid #94a3b8; border-bottom: 1px solid #94a3b8; }
        `);
        root.adoptedStyleSheets = [sheet];
        root.innerHTML = `
            <div class="bar">
                <span class="poptip" role="tooltip"></span>
                <div class="identity"><label for="wmc-media"></label><select class="media" id="wmc-media"></select></div>
                <div class="controls">
                <span class="handle" aria-hidden="true">⠿</span>
                <button class="play" type="button"></button>
                <span class="time">00:00 / 00:00</span>
                <div class="track"><div class="rail"></div><div class="head"></div><div class="ticks"></div></div>
                <span class="add-wrap"><button class="add" type="button">＋</button></span>
                <button class="dl" type="button">↓</button>
                <span class="badge" role="status" aria-live="polite"></span>
                <button class="view" type="button">↗</button>
                <button class="close" type="button">×</button>
                </div>
                <div class="editor"><div class="editor-header"><span></span><span class="start-label"></span>
                    <span class="end-label"></span><span class="duration-label"></span><span></span></div><div class="rows"></div></div>
                <div class="editor-footer"><span class="summary"></span></div>
                <div class="hint" role="status" aria-live="polite"></div>
            </div>`;

        const handle = root.querySelector(".handle");
        const play = root.querySelector(".play");
        const time = root.querySelector(".time");
        const track = root.querySelector(".track");
        const head = root.querySelector(".head");
        const add = root.querySelector(".add");
        const addWrap = root.querySelector(".add-wrap");
        const tip = root.querySelector(".poptip");
        const dl = root.querySelector(".dl");
        const hint = root.querySelector(".hint");
        const badge = root.querySelector(".badge");
        const close = root.querySelector(".close");
        const bar = root.querySelector(".bar");
        const view = root.querySelector(".view");
        const rows = root.querySelector(".rows");
        const summary = root.querySelector(".summary");
        root.querySelector(".start-label").textContent = msg("wmc_segmentStart");
        root.querySelector(".end-label").textContent = msg("wmc_segmentEnd");
        root.querySelector(".duration-label").textContent = msg("wmc_segmentDuration");
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
        let standard = standardView;
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
        const segments = [null, null]; // 槽位固定段色，删除后复用空槽；标准视图按需增加。
        const segEls = [];
        const editorRows = [];
        const invalidInputs = () => !!rows.querySelector('[aria-invalid="true"]');
        const createSlot = (index) => {
            const el = document.createElement("div");
            el.className = "seg";
            el.style.background = SEG_COLORS[index % SEG_COLORS.length];
            el.innerHTML = '<button class="edge start" type="button" role="slider"></button>' +
                '<button class="edge end" type="button" role="slider"></button>' +
                '<button class="delete" type="button">×</button>';
            const del = el.querySelector(".delete");
            del.setAttribute("aria-label", msg("wmc_deleteSegment"));
            const removeSegment = () => {
                segments[index] = null;
                editorRows[index].querySelectorAll("input").forEach((input) => input.removeAttribute("aria-invalid"));
                showHint("");
                render();
            };
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                removeSegment();
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
            segEls.push(el);

            const row = document.createElement("div");
            row.className = "clip-row";
            row.innerHTML = '<span class="clip-number"></span><input data-field="start" type="text" spellcheck="false">' +
                '<input data-field="end" type="text" spellcheck="false"><span class="clip-duration"></span>' +
                '<span class="clip-actions"><button class="locate" type="button">▶</button><button class="remove" type="button">×</button></span>';
            const number = row.querySelector(".clip-number");
            number.textContent = String(index + 1);
            number.style.background = SEG_COLORS[index % SEG_COLORS.length];
            const inputs = [...row.querySelectorAll("input")];
            const validate = () => {
                const [begin, end] = inputs.map((input) => parseStamp(input.value));
                const valid = !!segments[index] && Number.isFinite(begin) && Number.isFinite(end) &&
                    begin >= 0 && begin < end && end <= video.duration;
                inputs.forEach((input) => input.setAttribute("aria-invalid", String(!!segments[index] && !valid)));
                dl.disabled = invalidInputs();
                showHint(invalidInputs() ? msg("wmc_invalidSegmentTime") : "");
                return valid ? { start: begin, end } : null;
            };
            for (const input of row.querySelectorAll("input")) {
                input.setAttribute("aria-label", `${index + 1} ${msg(input.dataset.field === "start" ? "wmc_segmentStart" : "wmc_segmentEnd")}`);
                const apply = () => {
                    const next = validate();
                    if (!next) return;
                    segments[index] = next;
                    inputs.forEach((field) => { field.value = stamp(next[field.dataset.field]); });
                    render();
                };
                input.addEventListener("input", validate);
                input.addEventListener("change", apply);
                input.addEventListener("blur", () => { if (segments[index]) apply(); });
                input.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") { event.preventDefault(); apply(); }
                    if (event.key === "Escape" && segments[index]) {
                        inputs.forEach((field) => { field.value = stamp(segments[index][field.dataset.field]); });
                        validate();
                    }
                });
            }
            row.querySelector(".locate").setAttribute("aria-label", msg("wmc_locateSegment"));
            row.querySelector(".locate").addEventListener("click", () => {
                if (segments[index]) video.currentTime = segments[index].start;
            });
            row.querySelector(".remove").setAttribute("aria-label", msg("wmc_deleteSegment"));
            row.querySelector(".remove").addEventListener("click", removeSegment);
            rows.append(row);
            editorRows.push(row);
        };
        segments.forEach((_, index) => createSlot(index));

        const renderBadge = () => {
            const matching = jobs.filter((job) => job.pageUrl === location.href && job.mediaUrl === video.currentSrc);
            const count = matching.filter((job) => ["queued", "running"].includes(job.status)).length;
            const failed = matching.some((job) => ["failed", "interrupted"].includes(job.status));
            const done = matching.some((job) => job.status === "done");
            badge.textContent = count ? String(count) : failed ? "!" : done ? "✓" : "";
            badge.setAttribute("aria-label", count ? chrome.i18n.getMessage("wmc_activeDownloads", String(count)) :
                failed ? msg("wmc_statusFailed") : done ? msg("wmc_statusDone") : "");
        };

        const capabilityReasons = () => ["wmc_reasonNoRange", "wmc_reasonUnknownSource", "wmc_reasonLive", "wmc_reasonUnsupported"].map(msg);
        const standardHug = () => standard && !segments.some(Boolean) && start === null;
        let frameKey = "";
        const measureStandardHug = () => {
            const editor = root.querySelector(".editor");
            const prev = [host.style.height, bar.style.height, editor.style.flex];
            host.style.height = "auto";
            bar.style.height = "auto";
            editor.style.flex = "none";
            const height = Math.ceil(bar.getBoundingClientRect().height);
            [host.style.height, bar.style.height, editor.style.flex] = prev;
            return height;
        };
        const placeTip = () => {
            const barRect = bar.getBoundingClientRect();
            const btn = add.getBoundingClientRect();
            if (!(barRect.width > 0)) return;
            tip.style.left = `${btn.left + btn.width / 2 - barRect.left}px`;
        };
        const showTip = (open) => {
            if (open && tip.textContent) {
                placeTip();
                bar.dataset.tip = "open";
            } else delete bar.dataset.tip;
        };
        addWrap.addEventListener("pointerenter", () => showTip(true));
        addWrap.addEventListener("pointerleave", () => showTip(false));
        add.addEventListener("focus", () => showTip(true));
        add.addEventListener("blur", () => showTip(false));
        const fit = (left, top) => {
            const size = sizes[standard ? "standard" : "compact"];
            const availableWidth = Math.max(1, window.innerWidth - 2 * MARGIN);
            const availableHeight = Math.max(1, window.innerHeight - 2 * MARGIN);
            let width;
            let height;
            if (!standard) {
                const single = size.height < COMPACT_DOUBLE_H;
                const floor = single ? COMPACT_SINGLE_MIN : COMPACT_MIN_W;
                const maxW = Math.min(COMPACT_MAX_W, availableWidth);
                const minW = Math.min(floor, maxW);
                width = clamp(size.width, minW, Math.max(minW, maxW));
                height = width < COMPACT_SINGLE_MIN || !single ? COMPACT_DOUBLE_H : COMPACT_SINGLE_H;
                sizes.compact = { width, height };
            } else if (standardHug()) {
                const minWidth = Math.min(610, availableWidth);
                width = clamp(size.width, minWidth, Math.max(minWidth, Math.min(1200, availableWidth)));
                host.style.width = `${width}px`;
                height = Math.min(Math.max(measureStandardHug(), 1), availableHeight);
            } else {
                width = Math.min(size.width, availableWidth);
                height = Math.min(Math.max(size.height, 320), availableHeight);
            }
            host.style.width = `${width}px`;
            host.style.height = `${height}px`;
            host.style.left = `${clamp(left, 0, Math.max(0, window.innerWidth - width))}px`;
            host.style.top = `${clamp(top, 0, Math.max(0, window.innerHeight - height))}px`;
            bar.classList.toggle("roomy", !standard && height >= COMPACT_DOUBLE_H);
            if (bar.dataset.tip) placeTip();
        };
        const syncFrame = () => {
            const key = `${standard}:${segments.filter(Boolean).length}:${start === null}`;
            if (key === frameKey) return;
            frameKey = key;
            const rect = host.getBoundingClientRect();
            if (rect.width > 0) fit(rect.left, rect.top);
        };
        const place = () => {
            const rect = video.getBoundingClientRect();
            const hasRect = rect.width > 0 && rect.height > 0;
            const size = sizes[standard ? "standard" : "compact"];
            fit(hasRect ? rect.left + MARGIN : window.innerWidth - size.width - MARGIN,
                hasRect ? rect.bottom - size.height - MARGIN : window.innerHeight - size.height - MARGIN);
        };

        const render = () => {
            const duration = isFinite(video.duration) ? video.duration : 0;
            play.textContent = video.paused ? "▶" : "❚❚";
            play.setAttribute("aria-label", video.paused ? msg("wmc_play") : msg("wmc_pause"));
            const hours = duration >= 3600;
            time.textContent = `${fmt(video.currentTime, hours)} / ${fmt(duration, hours)}`;
            time.style.width = `${fmt(duration, hours).length * 2 + 3}ch`;
            head.style.left = `${pct(video.currentTime, duration)}%`;
            segEls.forEach((segEl, index) => {
                const pending = start !== null && index === pendingSlot;
                const block = pending ? { start, end: Math.max(start, Math.min(video.currentTime, duration)) } : segments[index];
                segEl.hidden = !block || (!standard && index >= 2);
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
            editorRows.forEach((row, index) => {
                const seg = segments[index];
                row.hidden = !seg;
                row.style.display = seg ? "" : "none";
                if (!seg) return;
                for (const input of row.querySelectorAll("input")) {
                    if (root.activeElement !== input && input.getAttribute("aria-invalid") !== "true") input.value = stamp(seg[input.dataset.field]);
                }
                row.querySelector(".clip-duration").textContent = stamp(seg.end - seg.start);
            });
            const count = segments.filter(Boolean).length;
            summary.textContent = chrome.i18n.getMessage("wmc_segmentsSummary", [String(count), stamp(segments.reduce((sum, seg) => sum + (seg ? seg.end - seg.start : 0), 0))]);
            const ticks = root.querySelector(".ticks");
            ticks.replaceChildren(...[0, .25, .5, .75, 1].map((fraction) => {
                const tick = document.createElement("span"); tick.textContent = fmt(duration * fraction, hours); return tick;
            }));
            dl.disabled = invalidInputs();
            dl.textContent = standard ? msg("wmc_download") : "↓";
            view.title = msg(standard ? "wmc_compactView" : "wmc_standardView");
            view.setAttribute("aria-label", view.title);
            view.textContent = standard ? "↙" : count > 2 ? `↗ ${count}` : "↗";
            view.style.width = !standard && count > 2 ? "auto" : "24px";
            add.textContent = standard ? `＋ ${msg("wmc_addSegment")}` : "＋";
            const addBlocked = blocked() || (!standard && start === null && segments.slice(0, 2).every(Boolean));
            add.disabled = false;
            add.classList.toggle("is-disabled", addBlocked);
            add.setAttribute("aria-disabled", String(addBlocked));
            const capabilityText = capability?.selectable === false ? msg(capability.reason || "wmc_reasonUnknownSource") : "";
            tip.textContent = capabilityText || (addBlocked && capability ? msg("wmc_maxSegments") : "");
            add.removeAttribute("title");
            if (invalidInputs()) showHint(msg("wmc_invalidSegmentTime"));
            else if (capabilityReasons().includes(hint.textContent)) showHint("");
            renderBadge();
            syncFrame();
        };

        const showHint = (text) => {
            hint.textContent = text;
        };

        const setView = (next) => {
            const rect = host.getBoundingClientRect();
            standard = next;
            standardView = next;
            bar.classList.toggle("standard", standard);
            const destination = root.querySelector(standard ? ".identity" : ".controls");
            destination.append(view, close);
            (standard ? root.querySelector(".editor-footer") : root.querySelector(".controls")).append(dl);
            if (!standard) root.querySelector(".controls").insertBefore(dl, badge);
            render();
            fit(rect.left, rect.top);
        };
        view.addEventListener("click", () => setView(!standard));

        play.addEventListener("click", () => {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
        });

        add.addEventListener("click", () => {
            if (add.getAttribute("aria-disabled") === "true") return;
            const now = video.currentTime;
            if (standard && start === null) {
                let index = segments.findIndex((seg) => !seg);
                if (index < 0) { index = segments.length; segments.push(null); createSlot(index); }
                const begin = Math.min(Math.max(0, now), Math.max(0, video.duration - .001));
                segments[index] = { start: begin, end: Math.min(video.duration, begin + 15) };
                showHint("");
                render();
                return;
            }
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
            if (invalidInputs()) { showHint(msg("wmc_invalidSegmentTime")); return; }
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

        for (const direction of ["n", "e", "s", "w", "ne", "nw", "se", "sw"]) {
            const edge = document.createElement("div");
            edge.className = `resize ${direction}`;
            edge.tabIndex = 0;
            edge.setAttribute("role", "button");
            edge.setAttribute("aria-label", `${msg("wmc_resizeOverlay")} (${direction})`);
            const resize = (rect, dx, dy) => {
                const edgeMax = direction.includes("w") ? rect.right : window.innerWidth - rect.left;
                const horizontal = direction.includes("e") || direction.includes("w");
                if (!standard) {
                    let layout = rect.height > COMPACT_SINGLE_H + 8 ? "double" : "single";
                    if (direction.includes("s") && dy > 8) layout = "double";
                    if (dy < -8 && (direction.includes("n") || horizontal)) layout = "single";
                    let width = rect.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0);
                    if (layout === "single") width = Math.max(width, COMPACT_SINGLE_MIN);
                    const maxW = Math.max(COMPACT_MIN_W, Math.min(COMPACT_MAX_W, edgeMax));
                    const minW = Math.min(layout === "single" ? COMPACT_SINGLE_MIN : COMPACT_MIN_W, maxW);
                    width = clamp(width, minW, maxW);
                    const height = layout === "double" || width < COMPACT_SINGLE_MIN ? COMPACT_DOUBLE_H : COMPACT_SINGLE_H;
                    sizes.compact = { width, height };
                    fit(direction.includes("w") ? rect.right - width : rect.left,
                        direction.includes("n") ? rect.bottom - height : rect.top);
                    return;
                }
                const minWidth = Math.min(610, Math.max(1, window.innerWidth - 2 * MARGIN));
                const maxWidth = Math.max(minWidth, Math.min(1200, edgeMax));
                const width = clamp(rect.width + (horizontal ? (direction.includes("e") ? dx : -dx) : 0), minWidth, maxWidth);
                if (standardHug()) {
                    sizes.standard.width = width;
                    fit(direction.includes("w") ? rect.right - width : rect.left, rect.top);
                    return;
                }
                const minHeight = Math.min(420, Math.max(1, window.innerHeight - 2 * MARGIN));
                const maxHeight = Math.max(minHeight, Math.min(window.innerHeight - 2 * MARGIN,
                    direction.includes("n") ? rect.bottom : window.innerHeight - rect.top));
                const height = clamp(rect.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0), minHeight, maxHeight);
                sizes.standard = { width, height };
                fit(direction.includes("w") ? rect.right - width : rect.left,
                    direction.includes("n") ? rect.bottom - height : rect.top);
            };
            edge.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const rect = host.getBoundingClientRect();
                const x = event.clientX, y = event.clientY;
                edge.setPointerCapture(event.pointerId);
                const move = (next) => resize(rect, next.clientX - x, next.clientY - y);
                const up = () => {
                    edge.removeEventListener("pointermove", move);
                    edge.removeEventListener("pointerup", up);
                    edge.removeEventListener("pointercancel", up);
                };
                edge.addEventListener("pointermove", move, { signal });
                edge.addEventListener("pointerup", up, { signal });
                edge.addEventListener("pointercancel", up, { signal });
            });
            edge.addEventListener("keydown", (event) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                resize(host.getBoundingClientRect(), event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0,
                    event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0);
            });
            bar.append(edge);
        }

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
                    rows.querySelectorAll("input").forEach((input) => input.removeAttribute("aria-invalid"));
                    showHint("");
                }
                if (meta) sourceDuration = video.duration;
                const retryNow = retryable() && Date.now() - resolveAt > 3000 && (meta || type === "timeupdate");
                if (!resolving && video.currentSrc && Number.isFinite(video.duration) &&
                    (!capability || retryNow)) resolveMedia();
                render();
            }, { signal });
        }
        window.addEventListener("resize", () => {
            const rect = host.getBoundingClientRect();
            fit(rect.left, rect.top);
        }, { signal });

        document.documentElement.appendChild(host);
        setView(standard);
        place();
        render();
        renderMedia();
        resolveMedia();
        return { video, renderBadge, renderMedia, hasSegments: () => start !== null || segments.some(Boolean),
            show: () => { host.style.display = ""; renderMedia(); const rect = host.getBoundingClientRect(); fit(rect.left, rect.top); },
            remove: () => { events.abort(); host.remove(); } };
    }
})();
