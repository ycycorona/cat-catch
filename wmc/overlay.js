// [WMC] 悬浮控制器：简洁/标准视图共用选段与下载状态。不读写 G/cacheData。
(() => {
    if (window.__wmcOverlay) return;
    window.__wmcOverlay = true;

    const MIN_DURATION = 10;
    const COMPACT_MIN_W = 680;
    const COMPACT_SINGLE_MIN = 760;
    const COMPACT_SINGLE_H = 82;
    const COMPACT_DOUBLE_H = 120;
    const SEG_COLORS = ["#3b82f6", "#f97316", "#22c55e"];
    const MARGIN = 16;
    const GAP = 4;
    const NATIVE_BAR = 48;
    let current = null;
    let dismissed = false;
    let latestVideo = null;
    let latestPlayedAt = 0;
    let followPlayback = true;
    let autoShow = false;
    let standardView = false;
    const sizes = {
        compact: { width: COMPACT_SINGLE_MIN, height: COMPACT_SINGLE_H, explicit: false },
        standard: { width: 760, height: 420, explicit: false }
    };
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

    // 播放条在视频框内时，下沿就是视频底边；条画在视频下方时，用包住它的播放窗口或相邻控件。
    // shortcut: 自带控件高度按 48px 估，只在视口放不下、又没测到自定义条时用来避开它。
    function playbackAnchor(video) {
        const rect = video.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return null;
        let left = rect.left;
        let width = rect.width;
        let bottom = rect.bottom;
        let node = video.parentElement;
        for (let depth = 0; node && node !== document.body && node !== document.documentElement && depth < 6; depth += 1, node = node.parentElement) {
            const box = node.getBoundingClientRect();
            if (box.width > rect.width + 48 || box.width < rect.width - 8) break;
            if (box.bottom - rect.bottom > 96 || box.top < rect.top - 80) break;
            left = box.left;
            width = box.width;
            bottom = Math.max(bottom, box.bottom);
        }
        let barTop = null;
        const scope = video.parentElement;
        if (scope) {
            for (const el of scope.children) {
                if (el === video || el.contains(video)) continue;
                const bar = el.getBoundingClientRect();
                if (bar.width < width * 0.7 || bar.height < 28 || bar.height > 96) continue;
                if (Math.abs(bar.left + bar.width / 2 - (left + width / 2)) > 48) continue;
                if (bar.top > bottom + 24 || bar.bottom < rect.bottom - bar.height - 8) continue;
                const name = `${el.id} ${el.getAttribute("class") || ""}`;
                const scrubber = el.querySelector("input[type=range], progress, [role=slider], [class*='progress'], [class*='Progress']");
                if (!scrubber && !/control|progress|playback|player-bar|chrome-bottom|vjs-control/i.test(name)) continue;
                bottom = Math.max(bottom, bar.bottom);
                barTop = barTop == null ? bar.top : Math.min(barTop, bar.top);
                if (bar.width > width && bar.width <= rect.width + 80) {
                    left = bar.left;
                    width = bar.width;
                }
            }
        }
        if (barTop == null && video.controls) barTop = bottom - NATIVE_BAR;
        return { left, width, bottom, barTop };
    }

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
            .identity .handle, .identity .dl, .identity .view, .identity .close { flex: none; }
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
            .seg { position: absolute; top: -9px; height: 8px; border-radius: 3px; touch-action: none; }
            .seg:not(.pending) { cursor: grab; }
            .seg.pending { opacity: .6; }
            .seg[hidden] { display: none; }
            .edge { position: absolute; top: -4px; z-index: 2; width: 8px; height: 16px; cursor: ew-resize;
                background: rgba(255,255,255,.5); touch-action: none; }
            .edge.start { left: 0; transform: translateX(-100%); }
            .edge.end { left: 100%; }
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
            .standard .controls { flex: none; flex-wrap: nowrap; align-items: center; gap: 4px; min-height: 22px; }
            .standard .play { width: 22px; height: 22px; }
            .standard .time { font-size: 11px; line-height: 22px; }
            .standard .track { display: none; }
            .axes, .zooms, .hint-btn { display: none; }
            .standard .axes { display: block; margin-top: 4px; }
            .standard .zooms, .standard .hint-btn { display: inline-flex; align-items: center; }
            .zooms { gap: 2px; flex: none; }
            .axis { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 6px; align-items: center; }
            .axis + .axis { margin-top: 4px; }
            .lab { color: #9ca3af; font-size: 11px; line-height: 14px; height: 14px; white-space: nowrap; }
            .axis.detail { align-items: end; }
            .axis.detail .lab { height: 26px; line-height: 26px; }
            .range { margin: 0 0 2px; color: #9ca3af; font: 10px/12px ui-monospace, Consolas, monospace;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ov, .plot { position: relative; border-radius: 3px; background: #1f2937; overflow: hidden; touch-action: none; }
            .ov { height: 14px; }
            .ov-shade { position: absolute; top: 0; bottom: 0; background: rgba(0,0,0,.5); pointer-events: none; }
            .ov-win { position: absolute; top: 1px; bottom: 1px; border: 1px solid #93c5fd; border-radius: 2px; background: rgba(147,197,253,.2); cursor: grab; }
            .ov-win .grip { position: absolute; top: -2px; bottom: -2px; width: 8px; cursor: ew-resize; }
            .ov-win .grip.l { left: -4px; } .ov-win .grip.r { right: -4px; }
            .omark { position: absolute; top: 0; bottom: 0; border-radius: 2px; pointer-events: none; }
            .ohead, .dhead { position: absolute; top: 0; bottom: 0; width: 1.5px; background: #f9fafb; z-index: 3; pointer-events: none; }
            .ohead::before, .dhead::before { content: ""; position: absolute; left: -4px; top: 0; border: 4px solid transparent; border-top-color: #38bdf8; }
            .dhead, .ohead { pointer-events: auto; cursor: ew-resize; }
            .dhead::after, .ohead::after { content: ""; position: absolute; left: -8px; top: 0; bottom: 0; width: 18px; }
            .ruler { position: relative; height: 14px; overflow: hidden; border-bottom: 1px solid rgba(255,255,255,.08); touch-action: none; }
            .ruler span { position: absolute; top: 0; color: #9ca3af; font: 10px/14px ui-monospace, Consolas, monospace; white-space: nowrap; }
            .lane { position: relative; height: 26px; overflow: hidden; touch-action: none; }
            .dseg { position: absolute; top: 5px; height: 16px; border-radius: 3px; touch-action: none; cursor: grab; }
            .dseg.pending { cursor: default; }
            .dseg .h { position: absolute; top: 0; bottom: 0; width: 6px; background: rgba(255,255,255,.72); cursor: ew-resize; z-index: 2; }
            .dseg .h.s { left: 0; transform: translateX(-100%); }
            .dseg .h.e { left: 100%; }
            .dseg.pending .h { display: none; }
            .dseg.picked { z-index: 3; box-shadow: inset 0 0 0 2px #fff, 0 0 0 1px rgba(255,255,255,.9); }
            .dhead { z-index: 4; }
            button.zoom-out, button.zoom-in { width: 22px; height: 22px; padding: 0; border: 1px solid #475569; line-height: 1; flex: none; font-size: 12px; }
            button.zoom-full, button.zoom-span { width: auto; height: 22px; padding: 0 6px; border: 1px solid #475569;
                line-height: 1; white-space: nowrap; flex: none; font-size: 11px; }
            button.zoom-span[aria-pressed="true"] { border-color: #93c5fd; color: #93c5fd; }
            button.hint-btn { width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid #93c5fd;
                color: #93c5fd; font-size: 10px; font-weight: 700; line-height: 1; flex: none; }
            .standard .identity .view, .standard .identity .close { width: 26px; height: 26px; flex: none; }
            button.studio { width: auto; height: 26px; padding: 0 8px; border: 1px solid #475569;
                white-space: nowrap; flex: none; font-size: 12px; }
            button.studio[aria-pressed="true"] { border-color: #93c5fd; color: #93c5fd; }
            .bar.studio-on { border-radius: 10px 10px 0 0; }
            .controls { position: relative; }
            .keys { position: absolute; z-index: 6; top: calc(100% + 6px); left: 148px; width: 300px; padding: 10px 12px;
                border-radius: 8px; background: #0f172a; border: 1px solid #334155; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
            .keys[hidden] { display: none; }
            .keys h2 { margin: 0 0 8px; font-size: 13px; }
            .keys dl { margin: 0; display: grid; gap: 6px; }
            .keys div { display: grid; grid-template-columns: 92px 1fr; gap: 8px; align-items: baseline; }
            .keys dt { margin: 0; font: 12px ui-monospace, Consolas, monospace; }
            .keys dd { margin: 0; color: #9ca3af; font-size: 12px; }
            .keys .close { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; }
            .standard .rows { max-height: 156px; overflow-y: auto; }
            .standard .rail { height: 6px; }
            .standard .seg { top: -10px; height: 24px; border: 1px solid rgba(255,255,255,.35); box-sizing: border-box; }
            .standard .edge { top: 1px; height: 20px; width: 6px; }
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
            .bar[data-tip] > .poptip:not(:empty) { display: block; }
            .edge[data-tip] > .poptip:not(:empty),
            .seg[data-tip] > .poptip:not(:empty) { display: block; }
            .standard .add-wrap { margin-left: auto; }
            button.add { width: auto; }
            .standard .add { height: 22px; padding: 0 6px; border: 1px solid #475569; white-space: nowrap; line-height: 1; font-size: 11px; }
            .standard .editor { display: block; overflow: auto; flex: none; min-height: 0; margin-top: 6px; }
            .editor-header, .clip-row { display: grid; grid-template-columns: 25px minmax(128px,1fr) minmax(128px,1fr) 95px 52px;
                gap: 8px; align-items: center; min-width: 500px; }
            .editor-header { color: #9ca3af; font-size: 12px; line-height: 16px; padding: 0 6px 4px; }
            .standard .editor-header, .standard .rows { scrollbar-gutter: stable; overflow-y: auto; }
            .clip-row { padding: 4px 6px; border-top: 1px solid rgba(255,255,255,.07); }
            .clip-row.picked { background: color-mix(in srgb, var(--seg) 14%, transparent); box-shadow: inset 3px 0 0 var(--seg); }
            .clip-row.picked input:not([aria-invalid="true"]) { border-color: color-mix(in srgb, var(--seg) 78%, #fff); }
            .clip-number { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 5px; }
            .clip-row input { box-sizing: border-box; width: 100%; min-width: 0; height: 31px; padding: 4px 6px;
                color: #f1f5f9; background: #121d2c; border: 1px solid #52637a; border-radius: 4px;
                font: 12px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
            .clip-row input:focus-visible { outline: 2px solid #60a5fa; }
            .clip-row.picked input:focus-visible:not([aria-invalid="true"]) { outline-color: var(--seg); }
            .clip-row input[aria-invalid=true] { border-color: #fb7185; background: #3b2432; }
            .clip-duration { color: #b3c2d7; font: 11px ui-monospace, Consolas, monospace; }
            .clip-actions { display: flex; gap: 3px; }
            .standard .editor-footer { display: flex; align-items: center; justify-content: space-between;
                flex: none; gap: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.1); }
            .summary { font-size: 11px; color: #9ca3af; }
            .editor-footer .dl { width: auto; height: 26px; padding: 0 10px; line-height: 1; white-space: nowrap; background: #2563eb; }
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
        `);
        root.adoptedStyleSheets = [sheet];
        root.innerHTML = `
            <div class="bar">
                <span class="poptip" role="tooltip"></span>
                <div class="identity"><label for="wmc-media"></label><select class="media" id="wmc-media"></select><button class="studio" type="button" aria-pressed="false"></button></div>
                <div class="controls">
                <span class="handle" aria-hidden="true">⠿</span>
                <button class="play" type="button"></button>
                <span class="time">00:00 / 00:00</span>
                <span class="zooms">
                <button class="zoom-out" type="button">−</button>
                <button class="zoom-in" type="button">+</button>
                <button class="zoom-span" type="button" data-span="300">5 min</button>
                <button class="zoom-span" type="button" data-span="900">15 min</button>
                <button class="zoom-span" type="button" data-span="1800">30 min</button>
                <button class="zoom-full" type="button"></button>
                </span>
                <button class="hint-btn" type="button" aria-expanded="false">!</button>
                <div class="keys" hidden role="dialog">
                    <button class="close" type="button">×</button>
                    <h2></h2>
                    <dl>
                        <div><dt>空格</dt><dd class="key-play"></dd></div>
                        <div><dt>+ / =</dt><dd class="key-in"></dd></div>
                        <div><dt>−</dt><dd class="key-out"></dd></div>
                        <div><dt>← / →</dt><dd class="key-step"></dd></div>
                        <div><dt>?</dt><dd class="key-help"></dd></div>
                        <div><dt>捏合</dt><dd class="key-pinch"></dd></div>
                        <div><dt>平移</dt><dd class="key-pan"></dd></div>
                        <div><dt>下滑</dt><dd class="key-scroll"></dd></div>
                    </dl>
                </div>
                <div class="track"><div class="rail"></div><div class="head"></div><div class="ticks"></div></div>
                <span class="add-wrap"><button class="add" type="button">＋</button></span>
                <button class="dl" type="button">↓</button>
                <span class="badge" role="status" aria-live="polite"></span>
                <button class="view" type="button">↗</button>
                <button class="close" type="button">×</button>
                </div>
                <div class="axes">
                    <div class="axis"><span class="lab ov-lab"></span><div class="ov"><div class="ov-shade left"></div><div class="ov-shade right"></div><div class="ov-marks"></div><div class="ov-win"><i class="grip l" data-edge="l"></i><i class="grip r" data-edge="r"></i></div><div class="ohead"></div></div></div>
                    <div class="axis detail"><span class="lab dt-lab"></span><div><div class="range"></div><div class="plot"><div class="ruler"></div><div class="lane"><div class="dhead"></div></div></div></div></div>
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
        const axes = root.querySelector(".axes");
        const ov = root.querySelector(".ov");
        const ovMarks = root.querySelector(".ov-marks");
        const ovWin = root.querySelector(".ov-win");
        const ohead = root.querySelector(".ohead");
        const lane = root.querySelector(".lane");
        const dhead = root.querySelector(".dhead");
        const ruler = root.querySelector(".ruler");
        const rangeLabel = root.querySelector(".range");
        const plot = root.querySelector(".plot");
        const keys = root.querySelector(".keys");
        const hintBtn = root.querySelector(".hint-btn");
        const detailSegs = [];
        const ovMarkEls = [];
        let windowView = null;
        let selectedSeg = -1;
        const MIN_SPAN = 5;
        root.querySelector(".ov-lab").textContent = msg("wmc_overview");
        root.querySelector(".dt-lab").textContent = msg("wmc_detail");
        root.querySelector(".zoom-out").title = msg("wmc_zoomOut");
        root.querySelector(".zoom-out").setAttribute("aria-label", msg("wmc_zoomOut"));
        root.querySelector(".zoom-in").title = msg("wmc_zoomIn");
        root.querySelector(".zoom-in").setAttribute("aria-label", msg("wmc_zoomIn"));
        root.querySelector(".zoom-full").textContent = msg("wmc_fullView");
        root.querySelector(".zoom-full").title = msg("wmc_fullView");
        const spanButtons = [...root.querySelectorAll(".zoom-span")];
        for (const button of spanButtons) {
            const label = chrome.i18n.getMessage("wmc_spanWindow", String(Number(button.dataset.span) / 60));
            button.title = label;
            button.setAttribute("aria-label", label);
        }
        hintBtn.title = msg("wmc_shortcuts");
        hintBtn.setAttribute("aria-label", msg("wmc_shortcuts"));
        keys.querySelector("h2").textContent = msg("wmc_shortcuts");
        keys.querySelector(".key-play").textContent = msg("wmc_keyPlay");
        keys.querySelector(".key-in").textContent = msg("wmc_keyZoomIn");
        keys.querySelector(".key-out").textContent = msg("wmc_keyZoomOut");
        keys.querySelector(".key-step").textContent = msg("wmc_keyPrevNext");
        keys.querySelector(".key-help").textContent = msg("wmc_keyHelp");
        keys.querySelector(".key-pinch").textContent = msg("wmc_keyPinch");
        keys.querySelector(".key-pan").textContent = msg("wmc_keyPan");
        keys.querySelector(".key-scroll").textContent = msg("wmc_keyScroll");
        const add = root.querySelector(".add");
        const addWrap = root.querySelector(".add-wrap");
        const tip = root.querySelector(".poptip");
        const dl = root.querySelector(".dl");
        const hint = root.querySelector(".hint");
        const badge = root.querySelector(".badge");
        const close = root.querySelector(".controls > .close");
        const bar = root.querySelector(".bar");
        bar.tabIndex = -1;
        const view = root.querySelector(".view");
        const rows = root.querySelector(".rows");
        const summary = root.querySelector(".summary");
        root.querySelector(".start-label").textContent = msg("wmc_segmentStart");
        root.querySelector(".end-label").textContent = msg("wmc_segmentEnd");
        root.querySelector(".duration-label").textContent = msg("wmc_segmentDuration");
        const media = root.querySelector(".media");
        root.querySelector(".identity label").textContent = msg("wmc_currentMedia");
        const studioBtn = root.querySelector(".studio");
        studioBtn.textContent = msg("wmc_studioMode");
        studioBtn.title = msg("wmc_studioMode");
        studioBtn.setAttribute("aria-label", msg("wmc_studioMode"));

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
        let edgeDrag = null;
        let bodyDrag = null;
        const edgeRange = (seg) => {
            const hours = isFinite(video.duration) && video.duration >= 3600;
            return `${fmt(seg.start, hours)} – ${fmt(seg.end, hours)}`;
        };
        const segEls = [];
        const editorRows = [];
        const invalidInputs = () => !!rows.querySelector('[aria-invalid="true"]');
        const ensureView = () => {
            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            if (!(duration > 0)) return { s: 0, e: MIN_SPAN };
            const minSpan = Math.min(MIN_SPAN, duration);
            if (!windowView) {
                const span = Math.min(duration, Math.max(minSpan, Math.min(duration, 20 * 60)));
                const s = clamp((video.currentTime || 0) - span * 0.35, 0, duration - span);
                windowView = { s, e: s + span };
            }
            const span = clamp(windowView.e - windowView.s, minSpan, duration);
            const s = clamp(windowView.s, 0, Math.max(0, duration - span));
            windowView = { s, e: s + span };
            return windowView;
        };
        const setWindow = (startAt, endAt) => {
            windowView = { s: startAt, e: endAt };
            ensureView();
            render();
        };
        let overviewScrub = false;
        let windowHold = false;
        let followAt = null;
        const overviewTime = (clientX) => {
            const rect = ov.getBoundingClientRect();
            if (!(rect.width > 0) || !(video.duration > 0)) return 0;
            return clamp((clientX - rect.left) / rect.width * video.duration, 0, video.duration);
        };
        // 贴到片头或片尾时窗口没法再居中：光标留在落点，选块靠齐那一侧。
        const centerWindow = (time) => {
            const span = ensureView().e - ensureView().s;
            const duration = video.duration || 0;
            const startAt = clamp(time - span / 2, 0, Math.max(0, duration - span));
            setWindow(startAt, startAt + span);
        };
        const focusOverview = (time) => {
            video.currentTime = time;
            centerWindow(time);
        };
        const zoomWindow = (factor, center) => {
            const v = ensureView();
            const c = center ?? (v.s + v.e) / 2;
            const span = (v.e - v.s) * factor;
            const ratio = (c - v.s) / (v.e - v.s || 1);
            setWindow(c - ratio * span, c - ratio * span + span);
        };
        const setSpan = (seconds) => {
            const v = ensureView();
            const center = (v.s + v.e) / 2;
            setWindow(center - seconds / 2, center + seconds / 2);
        };
        const detailTime = (clientX) => {
            const rect = lane.getBoundingClientRect();
            const v = ensureView();
            if (!(rect.width > 0)) return v.s;
            return clamp(v.s + (clientX - rect.left) / rect.width * (v.e - v.s), 0, video.duration || 0);
        };
        const pickSegment = (index) => {
            if (!segments[index] || selectedSeg === index) return;
            selectedSeg = index;
            render();
            editorRows[index]?.scrollIntoView({ block: "nearest" });
        };
        const createSlot = (index) => {
            const el = document.createElement("div");
            el.className = "seg";
            el.style.background = SEG_COLORS[index % SEG_COLORS.length];
            el.innerHTML = '<button class="edge start" type="button" role="slider"><span class="poptip" role="tooltip"></span></button>' +
                '<button class="edge end" type="button" role="slider"><span class="poptip" role="tooltip"></span></button>' +
                '<button class="delete" type="button">×</button>';
            const del = el.querySelector(".delete");
            del.setAttribute("aria-label", msg("wmc_deleteSegment"));
            const removeSegment = () => {
                segments[index] = null;
                if (selectedSeg === index) selectedSeg = -1;
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
                const pop = edge.querySelector(".poptip");
                edge.setAttribute("aria-label", msg(key === "start" ? "wmc_segmentStart" : "wmc_segmentEnd"));
                const openTip = () => {
                    const seg = segments[index];
                    if (bodyDrag || !seg || el.classList.contains("pending")) return;
                    edge.dataset.tip = "1";
                    pop.textContent = edgeRange(seg);
                };
                const closeTip = () => {
                    if (edgeDrag === edge) return;
                    delete edge.dataset.tip;
                    pop.textContent = "";
                };
                edge.addEventListener("pointerenter", openTip);
                edge.addEventListener("pointerleave", closeTip);
                // 拖过对方时停在 1ms 外，不让起点和终点对调。
                const adjust = (value) => {
                    const seg = segments[index];
                    if (!seg || !(video.duration > 0)) return;
                    if (key === "start") seg.start = clamp(value, 0, Math.max(0, seg.end - 0.001));
                    else seg.end = clamp(value, Math.min(video.duration, seg.start + 0.001), video.duration);
                    render();
                };
                edge.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    edgeDrag = edge;
                    openTip();
                    const rect = track.getBoundingClientRect();
                    const move = (ev) => adjust((ev.clientX - rect.left) / rect.width * video.duration);
                    const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        window.removeEventListener("pointercancel", up);
                        if (edgeDrag === edge) edgeDrag = null;
                        if (!edge.matches(":hover")) closeTip();
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
            const segPop = document.createElement("span");
            segPop.className = "poptip";
            segPop.setAttribute("role", "tooltip");
            el.append(segPop);
            el.addEventListener("pointerdown", (e) => {
                if (e.target.closest(".edge, .delete")) return;
                const seg = segments[index];
                if (!seg || el.classList.contains("pending") || edgeDrag) return;
                e.preventDefault();
                e.stopPropagation();
                const originX = e.clientX;
                const originStart = seg.start;
                const length = Math.max(0.001, seg.end - seg.start);
                const rect = track.getBoundingClientRect();
                bodyDrag = el;
                for (const edge of el.querySelectorAll(".edge")) {
                    delete edge.dataset.tip;
                    edge.querySelector(".poptip").textContent = "";
                }
                el.dataset.tip = "1";
                segPop.textContent = edgeRange(seg);
                const move = (ev) => {
                    const current = segments[index];
                    if (!current || !(rect.width > 0) || !isFinite(video.duration)) return;
                    const next = clamp(originStart + (ev.clientX - originX) / rect.width * video.duration, 0, Math.max(0, video.duration - length));
                    current.start = next;
                    current.end = next + length;
                    render();
                };
                const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    window.removeEventListener("pointercancel", up);
                    if (bodyDrag === el) bodyDrag = null;
                    delete el.dataset.tip;
                    segPop.textContent = "";
                    const hovered = [...el.querySelectorAll(".edge")].find((edge) => edge.matches(":hover"));
                    if (hovered && segments[index]) {
                        hovered.dataset.tip = "1";
                        hovered.querySelector(".poptip").textContent = edgeRange(segments[index]);
                    }
                };
                window.addEventListener("pointermove", move, { signal });
                window.addEventListener("pointerup", up, { signal });
                window.addEventListener("pointercancel", up, { signal });
            });
            root.querySelector(".rail").append(el);
            segEls.push(el);
            const detail = document.createElement("div");
            const segColor = SEG_COLORS[index % SEG_COLORS.length];
            detail.className = "dseg";
            detail.style.background = segColor;
            detail.style.setProperty("--seg", segColor);
            detail.innerHTML = '<i class="h s" data-edge="start"></i><i class="h e" data-edge="end"></i>';
            detail.hidden = true;
            lane.append(detail);
            detailSegs[index] = detail;
            const mark = document.createElement("div");
            mark.className = "omark";
            mark.style.background = SEG_COLORS[index % SEG_COLORS.length];
            mark.hidden = true;
            ovMarks.append(mark);
            ovMarkEls[index] = mark;
            const dragEdge = (key, e) => {
                e.preventDefault();
                e.stopPropagation();
                pickSegment(index);
                const move = (ev) => {
                    const seg = segments[index];
                    if (!seg || !(video.duration > 0)) return;
                    const value = detailTime(ev.clientX);
                    if (key === "start") seg.start = clamp(value, 0, Math.max(0, seg.end - 0.001));
                    else seg.end = clamp(value, Math.min(video.duration, seg.start + 0.001), video.duration);
                    render();
                };
                const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    window.removeEventListener("pointercancel", up);
                };
                window.addEventListener("pointermove", move, { signal });
                window.addEventListener("pointerup", up, { signal });
                window.addEventListener("pointercancel", up, { signal });
            };
            detail.querySelectorAll(".h").forEach((handle) => {
                handle.addEventListener("pointerdown", (e) => dragEdge(handle.dataset.edge, e));
            });
            detail.addEventListener("pointerdown", (e) => {
                if (e.target.closest(".h")) return;
                const seg = segments[index];
                if (!seg || detail.classList.contains("pending")) return;
                pickSegment(index);
                e.preventDefault();
                e.stopPropagation();
                const originX = e.clientX, originStart = seg.start;
                const length = Math.max(0.001, seg.end - seg.start);
                const width = lane.getBoundingClientRect().width;
                const span = () => { const v = ensureView(); return v.e - v.s; };
                const move = (ev) => {
                    const current = segments[index];
                    if (!current || !(width > 0)) return;
                    const next = clamp(originStart + (ev.clientX - originX) / width * span(), 0, Math.max(0, video.duration - length));
                    current.start = next;
                    current.end = next + length;
                    render();
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

            const row = document.createElement("div");
            row.className = "clip-row";
            row.style.setProperty("--seg", segColor);
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
                const seekField = () => {
                    const seg = segments[index];
                    const time = seg?.[input.dataset.field];
                    if (Number.isFinite(time)) video.currentTime = time;
                };
                const apply = () => {
                    const next = validate();
                    if (!next) return;
                    segments[index] = next;
                    inputs.forEach((field) => { field.value = stamp(next[field.dataset.field]); });
                    seekField();
                    render();
                };
                input.addEventListener("focus", () => { pickSegment(index); seekField(); });
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
            row.addEventListener("pointerdown", (event) => {
                if (event.target.closest(".remove") || !segments[index]) return;
                pickSegment(index);
            });
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
        const scrub = (e) => { if (video.duration > 0) { video.currentTime = detailTime(e.clientX); render(); } };
        const watch = (el, down) => {
            el.addEventListener("pointerdown", (e) => {
                if (e.button !== 0) return;
                const drag = down(e);
                if (!drag) return;
                e.preventDefault();
                const move = (ev) => drag.move?.(ev);
                const up = (ev) => {
                    drag.end?.(ev);
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    window.removeEventListener("pointercancel", up);
                };
                window.addEventListener("pointermove", move, { signal });
                window.addEventListener("pointerup", up, { signal });
                window.addEventListener("pointercancel", up, { signal });
            });
        };
        watch(dhead, () => ({ move: scrub }));
        watch(ruler, () => ({ move: scrub, end: scrub }));
        watch(lane, (e) => {
            if (e.target.closest(".dhead, .dseg")) return null;
            let last = detailTime(e.clientX), moved = false;
            return {
                move(ev) {
                    const now = detailTime(ev.clientX), delta = now - last;
                    last = now;
                    if (Math.abs(delta) > 0.05) moved = true;
                    if (moved) { windowHold = true; const v = ensureView(); setWindow(v.s - delta, v.e - delta); }
                },
                end(ev) {
                    windowHold = false;
                    if (!moved && video.duration > 0) { video.currentTime = detailTime(ev.clientX); render(); }
                }
            };
        });
        watch(ov, (e) => {
            if (e.target === ohead) return null;
            const edge = e.target.dataset?.edge;
            const at = (ev) => overviewTime(ev.clientX);
            const t = at(e);
            if (edge) return {
                move(ev) {
                    windowHold = true;
                    const now = at(ev); const v = ensureView();
                    if (edge === "l") setWindow(now, v.e); else setWindow(v.s, now);
                },
                end() { windowHold = false; },
            };
            if (e.target === ovWin || e.target.classList.contains("ov-win")) {
                let last = t;
                return {
                    move(ev) {
                        windowHold = true;
                        const now = at(ev), delta = now - last; last = now; const v = ensureView();
                        setWindow(v.s + delta, v.e + delta);
                    },
                    end() { windowHold = false; },
                };
            }
            let moved = false;
            return {
                move(ev) {
                    const now = at(ev);
                    if (Math.abs(now - t) > video.duration * 0.003) {
                        moved = true;
                        windowHold = true;
                        setWindow(Math.min(t, now), Math.max(t, now));
                    }
                },
                end(ev) { windowHold = false; if (!moved) centerWindow(at(ev)); }
            };
        });
        ohead.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || !(video.duration > 0)) return;
            e.preventDefault();
            e.stopPropagation();
            const originX = e.clientX;
            let moved = false;
            const move = (ev) => {
                if (!moved && Math.abs(ev.clientX - originX) <= 3) return;
                moved = true;
                overviewScrub = true;
                video.currentTime = overviewTime(ev.clientX);
                render();
            };
            const up = (ev) => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
                overviewScrub = false;
                if (!moved) return;
                video.currentTime = overviewTime(ev.clientX);
                centerWindow(video.currentTime);
            };
            window.addEventListener("pointermove", move, { signal });
            window.addEventListener("pointerup", up, { signal });
            window.addEventListener("pointercancel", up, { signal });
        });
        ov.addEventListener("dblclick", (e) => {
            if (e.target.closest(".grip") || !(video.duration > 0)) return;
            e.preventDefault();
            focusOverview(overviewTime(e.clientX));
        });
        const axisWheel = (timeAt) => (ev) => {
            const width = ev.currentTarget.getBoundingClientRect().width || 1;
            if (ev.ctrlKey || ev.metaKey) {
                ev.preventDefault();
                zoomWindow(Math.exp(ev.deltaY * 0.0022), timeAt(ev.clientX));
            } else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey) {
                ev.preventDefault();
                const v = ensureView();
                const delta = (ev.shiftKey ? ev.deltaY : ev.deltaX) / width * (v.e - v.s);
                setWindow(v.s + delta, v.e + delta);
            } else if (rows.scrollHeight > rows.clientHeight + 1) {
                rows.scrollTop += ev.deltaY;
                ev.preventDefault();
            }
        };
        plot.addEventListener("wheel", axisWheel(detailTime), { passive: false, signal });
        ov.addEventListener("wheel", axisWheel((x) => {
            const rect = ov.getBoundingClientRect();
            return clamp((x - rect.left) / rect.width * (video.duration || 0), 0, video.duration || 0);
        }), { passive: false, signal });
        for (const type of ["gesturestart", "gesturechange"]) {
            for (const el of [plot, ov]) el.addEventListener(type, (ev) => ev.preventDefault(), { passive: false, signal });
        }
        axes.addEventListener("pointerdown", (ev) => {
            if (!ev.target.closest("input, select, textarea")) bar.focus({ preventScroll: true });
        });
        const toggleKeys = (force) => {
            const open = force ?? keys.hidden;
            keys.hidden = !open;
            hintBtn.setAttribute("aria-expanded", String(open));
            if (open) keys.style.left = `${Math.max(0, Math.min(hintBtn.offsetLeft, hintBtn.parentElement.clientWidth - keys.offsetWidth))}px`;
        };
        hintBtn.addEventListener("click", () => toggleKeys());
        keys.querySelector(".close").addEventListener("click", () => toggleKeys(false));
        bar.addEventListener("click", (ev) => {
            if (!keys.hidden && !keys.contains(ev.target) && ev.target !== hintBtn) toggleKeys(false);
        });
        root.querySelector(".zoom-in").addEventListener("click", () => zoomWindow(0.5));
        root.querySelector(".zoom-out").addEventListener("click", () => zoomWindow(2));
        for (const button of spanButtons) {
            button.addEventListener("click", () => setSpan(Number(button.dataset.span)));
        }
        root.querySelector(".zoom-full").addEventListener("click", () => setWindow(0, video.duration || 0));
        const showSegment = (dir) => {
            const indexes = segments.map((seg, i) => seg ? i : -1).filter((i) => i >= 0);
            if (!indexes.length) return;
            let pos = indexes.indexOf(selectedSeg);
            if (pos < 0) pos = dir > 0 ? -1 : 0;
            selectedSeg = indexes[(pos + dir + indexes.length) % indexes.length];
            const seg = segments[selectedSeg];
            const pad = Math.max((seg.end - seg.start) * 0.35, 2);
            setWindow(seg.start - pad, seg.end + pad);
            editorRows[selectedSeg]?.scrollIntoView({ block: "nearest" });
        };
        bar.addEventListener("keydown", (ev) => {
            if (ev.target.closest("input, select, textarea")) return;
            const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
            if (ev.key === "Escape") {
                if (!keys.hidden) toggleKeys(false);
                else if (studio) exitStudio();
                return;
            }
            if (ev.key === "?") { ev.preventDefault(); toggleKeys(); return; }
            if (!plain || !standard) return;
            if (ev.key === " " && !ev.target.closest("button")) { ev.preventDefault(); if (!ev.repeat) play.click(); }
            else if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomWindow(0.5); }
            else if (ev.key === "-" || ev.key === "−") { ev.preventDefault(); zoomWindow(2); }
            else if (ev.key === "ArrowLeft") { ev.preventDefault(); showSegment(-1); }
            else if (ev.key === "ArrowRight") { ev.preventDefault(); showSegment(1); }
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

        let frameKey = "";
        // 行少时按内容收高；量到的是整份列表，调用方再把高度限制在视口内。
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
        let tipTarget = null;
        let tipText = () => "";
        const placeTip = () => {
            const barRect = bar.getBoundingClientRect();
            const btn = tipTarget?.getBoundingClientRect();
            if (!btn || !(barRect.width > 0)) return;
            tip.style.left = `${btn.left + btn.width / 2 - barRect.left}px`;
            tip.style.bottom = "auto";
            tip.style.top = `${btn.top - barRect.top - 8}px`;
            tip.style.transform = "translate(-50%, -100%)";
        };
        const showTip = (open) => {
            if (open && tip.textContent) {
                placeTip();
                bar.dataset.tip = "open";
            } else delete bar.dataset.tip;
        };
        const bindTip = (button, text) => {
            const open = () => {
                tipTarget = button;
                tipText = text;
                tip.textContent = text();
                showTip(true);
            };
            const close = () => { if (tipTarget === button) showTip(false); };
            button.addEventListener("pointerenter", open);
            button.addEventListener("pointerleave", close);
            button.addEventListener("focus", open);
            button.addEventListener("blur", close);
        };
        bindTip(play, () => msg("wmc_playPause"));
        bindTip(add, () => {
            if (capability?.selectable === false) return `${msg("wmc_addSegment")} · ${msg(capability.reason || "wmc_reasonUnknownSource")}`;
            if (!standard && start === null && segments.slice(0, 2).every(Boolean)) return msg("wmc_maxSegments");
            return msg("wmc_addSegment");
        });
        bindTip(dl, () => msg("wmc_download"));
        bindTip(view, () => msg(standard ? "wmc_compactView" : "wmc_standardView"));
        bindTip(close, () => msg("wmc_tipClose"));
        let docked = true;
        let studio = false;
        let studioReturnStandard = false;
        let studioStyle = null;
        let studioControls = false;
        let studioScroll = null;
        const studioAncestors = [];
        const studioSheets = [];
        let studioStage = null;
        // 祖先不抬到黑幕之上时，画面的 z-index 困在播放器自己的层里，视口只剩黑幕。
        const STUDIO_CSS = `.wmc-studio-open{position:relative !important;z-index:2147482999 !important;overflow:visible !important;transform:none !important;translate:none !important;rotate:none !important;scale:none !important;filter:none !important;backdrop-filter:none !important;perspective:none !important;contain:none !important;clip-path:none !important;mask:none !important;container-type:normal !important;will-change:auto !important;opacity:1 !important;mix-blend-mode:normal !important;}[data-wmc-studio]{position:fixed !important;top:0 !important;left:0 !important;margin:0 !important;padding:0 !important;border:none !important;z-index:2147482999 !important;object-fit:contain !important;object-position:center center !important;background:#000 !important;transform:none !important;opacity:1 !important;visibility:visible !important;}`;
        const addStudioSheet = (parent) => {
            const existing = [...parent.children].find((el) => el.dataset && el.dataset.wmcStudioStyle);
            if (existing) { if (!studioSheets.includes(existing)) studioSheets.push(existing); return; }
            const style = document.createElement("style");
            style.dataset.wmcStudioStyle = "1";
            style.textContent = STUDIO_CSS;
            parent.append(style);
            studioSheets.push(style);
        };
        const layoutStudio = () => {
            const maxBand = Math.max(1, Math.floor(window.innerHeight * 0.6));
            host.style.left = "0px";
            host.style.width = `${window.innerWidth}px`;
            const content = Math.max(measureStandardHug(), 1);
            const editor = root.querySelector(".editor");
            const height = Math.min(content, maxBand);
            editor.style.flex = content > maxBand ? "1" : "none";
            host.style.height = `${height}px`;
            host.style.top = `${Math.max(0, window.innerHeight - height)}px`;
            const picture = Math.max(0, window.innerHeight - height);
            video.style.setProperty("width", `${window.innerWidth}px`, "important");
            video.style.setProperty("max-width", `${window.innerWidth}px`, "important");
            video.style.setProperty("height", `${picture}px`, "important");
            video.style.setProperty("max-height", `${picture}px`, "important");
        };
        const exitStudio = () => {
            if (!studio) return;
            const back = studioReturnStandard;
            studio = false;
            bar.classList.remove("studio-on");
            studioBtn.setAttribute("aria-pressed", "false");
            video.removeAttribute("data-wmc-studio");
            if (studioStyle == null) video.removeAttribute("style");
            else video.setAttribute("style", studioStyle);
            if (studioControls) video.setAttribute("controls", "");
            else video.removeAttribute("controls");
            studioStyle = null;
            for (const el of studioAncestors) el.classList.remove("wmc-studio-open");
            studioAncestors.length = 0;
            for (const style of studioSheets) style.remove();
            studioSheets.length = 0;
            studioStage?.remove();
            studioStage = null;
            for (const saved of studioScroll || []) {
                if (saved.value) saved.el.style.setProperty("overflow", saved.value, saved.priority);
                else saved.el.style.removeProperty("overflow");
                if (saved.bg) saved.el.style.setProperty("background-color", saved.bg, saved.bgPriority);
                else saved.el.style.removeProperty("background-color");
            }
            studioScroll = null;
            docked = true;
            if (standard !== back) setView(back);
            else place();
        };
        const enterStudio = () => {
            if (studio) return;
            studioReturnStandard = standard;
            studio = true;
            bar.classList.add("studio-on");
            studioBtn.setAttribute("aria-pressed", "true");
            studioStyle = video.getAttribute("style");
            studioControls = video.hasAttribute("controls");
            video.removeAttribute("controls");
            video.setAttribute("data-wmc-studio", "");
            addStudioSheet(document.head || document.documentElement);
            let node = video.parentNode;
            while (node && node !== document) {
                if (node instanceof ShadowRoot) addStudioSheet(node);
                else if (node instanceof HTMLElement && node !== document.documentElement) {
                    const rootNode = node.getRootNode();
                    if (rootNode instanceof ShadowRoot) addStudioSheet(rootNode);
                    node.classList.add("wmc-studio-open");
                    studioAncestors.push(node);
                }
                node = node.parentNode || (node instanceof ShadowRoot ? node.host : null);
            }
            studioStage = document.createElement("div");
            studioStage.id = "wmc-studio-stage";
            studioStage.setAttribute("aria-hidden", "true");
            studioStage.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147482998;pointer-events:none;";
            document.documentElement.append(studioStage);
            studioScroll = [document.documentElement, document.body].filter(Boolean).map((el) => ({
                el,
                value: el.style.getPropertyValue("overflow"),
                priority: el.style.getPropertyPriority("overflow"),
                bg: el.style.getPropertyValue("background-color"),
                bgPriority: el.style.getPropertyPriority("background-color"),
            }));
            for (const saved of studioScroll) {
                saved.el.style.setProperty("overflow", "hidden", "important");
                saved.el.style.setProperty("background-color", "#000", "important");
            }
            if (!standard) setView(true);
            else place();
            bar.focus({ preventScroll: true });
        };
        const fit = (left, top) => {
            if (studio) { layoutStudio(); return; }
            const size = sizes[standard ? "standard" : "compact"];
            const availableWidth = Math.max(1, window.innerWidth - (docked ? 0 : 2 * MARGIN));
            const availableHeight = Math.max(1, window.innerHeight - 2 * MARGIN);
            let width;
            let height;
            if (!standard && size.explicit) {
                width = clamp(size.width, 1, availableWidth);
                height = clamp(size.height, 1, availableHeight);
            } else if (!standard) {
                const single = size.height < COMPACT_DOUBLE_H;
                const floor = single ? COMPACT_SINGLE_MIN : COMPACT_MIN_W;
                const maxW = availableWidth;
                const minW = Math.min(floor, maxW, docked ? size.width : maxW);
                width = clamp(size.width, minW, Math.max(minW, maxW));
                height = width < COMPACT_SINGLE_MIN || !single ? COMPACT_DOUBLE_H : COMPACT_SINGLE_H;
            } else if (size.explicit) {
                width = clamp(size.width, 1, availableWidth);
                height = clamp(size.height, 1, availableHeight);
                root.querySelector(".editor").style.flex = "1";
            } else {
                const minWidth = Math.min(610, availableWidth, docked ? size.width : availableWidth);
                width = clamp(size.width, minWidth, Math.max(minWidth, availableWidth));
                host.style.width = `${width}px`;
                const editor = root.querySelector(".editor");
                const content = Math.max(measureStandardHug(), 1);
                if (content > availableHeight) {
                    editor.style.flex = "1";
                    height = availableHeight;
                } else {
                    editor.style.flex = "none";
                    height = content;
                }
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
            if (studio) { layoutStudio(); return; }
            const anchor = playbackAnchor(video);
            const size = sizes[standard ? "standard" : "compact"];
            if (!anchor) {
                fit(window.innerWidth - size.width - MARGIN, window.innerHeight - size.height - MARGIN);
                return;
            }
            if (!sizes.compact.explicit) sizes.compact.width = anchor.width;
            if (!sizes.standard.explicit) sizes.standard.width = anchor.width;
            const desiredTop = anchor.bottom + GAP;
            fit(anchor.left, desiredTop);
            const placed = host.getBoundingClientRect();
            if (placed.top < desiredTop - 1) {
                const barTop = anchor.barTop ?? anchor.bottom - NATIVE_BAR;
                const above = barTop - GAP - placed.height;
                if (above >= 0) fit(anchor.left, above);
            }
        };

        const render = () => {
            const duration = isFinite(video.duration) ? video.duration : 0;
            play.textContent = video.paused ? "▶" : "❚❚";
            play.setAttribute("aria-label", video.paused ? msg("wmc_play") : msg("wmc_pause"));
            const hours = duration >= 3600;
            time.textContent = `${fmt(video.currentTime, hours)} / ${fmt(duration, hours)}`;
            time.style.width = `${fmt(duration, hours).length * 2 + 3}ch`;
            head.style.left = `${pct(video.currentTime, duration)}%`;
            // 只在播放头自己走进窗口右侧十分之一时翻页。拖动选块时不跟，光标落在选块外面也不拉回来。
            if (standard && windowView && duration > 0) {
                const span = windowView.e - windowView.s;
                const t = video.currentTime;
                const advanced = followAt != null && t > followAt + 0.001;
                if (!video.paused && !overviewScrub && !windowHold && advanced &&
                    t >= windowView.s && t <= windowView.e && t > windowView.e - span * 0.1 && t < duration) {
                    const s = clamp(t - span * 0.1, 0, Math.max(0, duration - span));
                    windowView = { s, e: s + span };
                }
                followAt = t;
            }
            const v = standard && duration > 0 ? ensureView() : null;
            if (v) {
                const span = v.e - v.s;
                ov.querySelector(".ov-shade.left").style.width = `${v.s / duration * 100}%`;
                const rightShade = ov.querySelector(".ov-shade.right");
                rightShade.style.left = `${v.e / duration * 100}%`;
                rightShade.style.width = `${Math.max(0, duration - v.e) / duration * 100}%`;
                ovWin.style.left = `${v.s / duration * 100}%`;
                ovWin.style.width = `${span / duration * 100}%`;
                ohead.style.left = `${pct(video.currentTime, duration)}%`;
                rangeLabel.textContent = `${fmt(v.s, hours)} – ${fmt(v.e, hours)}`;
                const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((n) => n >= span / 6) || 3600;
                ruler.replaceChildren();
                for (let t = Math.ceil(v.s / step) * step; t <= v.e; t += step) {
                    const pos = (t - v.s) / span;
                    const tick = document.createElement("span");
                    tick.style.left = `${pos * 100}%`;
                    tick.style.transform = pos < 0.08 ? "translateX(0)" : pos > 0.92 ? "translateX(-100%)" : "translateX(-50%)";
                    tick.textContent = fmt(t, hours);
                    ruler.append(tick);
                }
                dhead.style.left = `${(video.currentTime - v.s) / span * 100}%`;
                dhead.hidden = video.currentTime < v.s || video.currentTime > v.e;
            }
            for (const button of spanButtons) {
                const on = v && Math.abs((v.e - v.s) - Number(button.dataset.span)) < 0.5;
                button.setAttribute("aria-pressed", on ? "true" : "false");
            }
            ovMarkEls.forEach((mark, index) => {
                const seg = segments[index];
                mark.hidden = !seg || !(duration > 0);
                if (mark.hidden) return;
                mark.style.left = `${seg.start / duration * 100}%`;
                mark.style.width = `${Math.max((seg.end - seg.start) / duration * 100, 0.15)}%`;
            });
            detailSegs.forEach((detail, index) => {
                const pending = start !== null && index === pendingSlot;
                const block = pending ? { start, end: Math.max(start, Math.min(video.currentTime, duration)) } : segments[index];
                const span = v ? v.e - v.s : 0;
                const visible = !!(v && block && block.end > v.s && block.start < v.e);
                detail.hidden = !visible;
                detail.classList.toggle("pending", !!pending);
                detail.classList.toggle("picked", index === selectedSeg && !!segments[index] && !pending);
                if (!visible) return;
                const left = Math.max(block.start, v.s);
                const right = Math.min(block.end, v.e);
                detail.style.left = `${(left - v.s) / span * 100}%`;
                detail.style.width = `${Math.max(0, right - left) / span * 100}%`;
                detail.querySelector(".h.s").hidden = block.start < v.s || pending;
                detail.querySelector(".h.e").hidden = block.end > v.e || pending;
            });
            segEls.forEach((segEl, index) => {
                const pending = start !== null && index === pendingSlot;
                const block = pending ? { start, end: Math.max(start, Math.min(video.currentTime, duration)) } : segments[index];
                segEl.hidden = !block || (!standard && index >= 2);
                if (!block) {
                    delete segEl.dataset.tip;
                    segEl.querySelectorAll(".edge").forEach((edge) => { delete edge.dataset.tip; });
                    segEl.querySelectorAll(".poptip").forEach((pop) => { pop.textContent = ""; });
                    return;
                }
                segEl.classList.toggle("pending", pending);
                segEl.style.left = `${pct(block.start, duration)}%`;
                segEl.style.width = `${pct(block.end, duration) - pct(block.start, duration)}%`;
                for (const key of ["start", "end"]) {
                    const edge = segEl.querySelector(`.edge.${key}`);
                    const pop = edge.querySelector(".poptip");
                    if (!segments[index] || pending) {
                        delete edge.dataset.tip;
                        pop.textContent = "";
                    } else if (edge.dataset.tip) pop.textContent = edgeRange(segments[index]);
                    edge.setAttribute("aria-valuemin", key === "start" ? "0" : String(block.start));
                    edge.setAttribute("aria-valuemax", String(key === "start" ? block.end : duration));
                    edge.setAttribute("aria-valuenow", String(block[key]));
                }
                const segPop = segEl.querySelector(":scope > .poptip");
                if (!segments[index] || pending) {
                    delete segEl.dataset.tip;
                    if (segPop) segPop.textContent = "";
                } else if (segEl.dataset.tip && segPop) segPop.textContent = edgeRange(segments[index]);
            });
            editorRows.forEach((row, index) => {
                const seg = segments[index];
                row.hidden = !seg;
                row.style.display = seg ? "" : "none";
                row.classList.toggle("picked", index === selectedSeg && !!seg);
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
            view.setAttribute("aria-label", msg(standard ? "wmc_compactView" : "wmc_standardView"));
            view.textContent = standard ? "↙" : count > 2 ? `↗ ${count}` : "↗";
            view.style.width = !standard && count > 2 ? "auto" : "";
            add.textContent = standard ? `＋ ${msg("wmc_addSegment")}` : "＋";
            const addBlocked = blocked() || (!standard && start === null && segments.slice(0, 2).every(Boolean));
            add.disabled = false;
            add.classList.toggle("is-disabled", addBlocked);
            add.setAttribute("aria-disabled", String(addBlocked));
            if (bar.dataset.tip) {
                tip.textContent = tipText();
                placeTip();
            }
            add.removeAttribute("title");
            if (invalidInputs()) showHint(msg("wmc_invalidSegmentTime"));
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
            const controls = root.querySelector(".controls");
            const identity = root.querySelector(".identity");
            if (standard) {
                identity.prepend(handle);
                identity.append(view, close);
                controls.append(badge);
                root.querySelector(".editor-footer").append(dl);
            } else {
                identity.prepend(handle);
                identity.append(dl, badge, view, close);
            }
            render();
            if (docked) place();
            else fit(rect.left, rect.top);
        };
        view.addEventListener("click", () => setView(!standard));
        studioBtn.addEventListener("click", () => { if (studio) exitStudio(); else enterStudio(); });

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
                const v = ensureView();
                if (begin < v.s || begin > v.e) setWindow(begin - (v.e - v.s) * 0.2, begin + (v.e - v.s) * 0.8);
                else render();
                rows.scrollTop = rows.scrollHeight;
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
                const reason = response?.error && msg(response.error);
                showHint(error || !response?.ok ? (reason || msg("wmc_submitFailed")) :
                    selected.length ? "" : msg("wmc_wholeStarted"));
            });
        });

        close.addEventListener("click", () => {
            exitStudio();
            dismissed = true;
            host.style.display = "none";
        });

        handle.addEventListener("pointerdown", (e) => {
            if (studio) return;
            e.preventDefault();
            const rect = host.getBoundingClientRect();
            const dx = e.clientX - rect.left;
            const dy = e.clientY - rect.top;
            const move = (ev) => {
                docked = false;
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
                if (studio) return;
                docked = false;
                const edgeMax = direction.includes("w") ? rect.right : window.innerWidth - rect.left;
                const horizontal = direction.includes("e") || direction.includes("w");
                if (!standard) {
                    let layout = rect.height > COMPACT_SINGLE_H + 8 ? "double" : "single";
                    if (direction.includes("s") && dy > 8) layout = "double";
                    if (dy < -8 && (direction.includes("n") || horizontal)) layout = "single";
                    let width = rect.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0);
                    if (layout === "single") width = Math.max(width, COMPACT_SINGLE_MIN);
                    const maxW = Math.max(COMPACT_MIN_W, edgeMax);
                    const minW = Math.min(layout === "single" ? COMPACT_SINGLE_MIN : COMPACT_MIN_W, maxW);
                    width = clamp(width, minW, maxW);
                    const height = layout === "double" || width < COMPACT_SINGLE_MIN ? COMPACT_DOUBLE_H : COMPACT_SINGLE_H;
                    sizes.compact = { width, height, explicit: true };
                    fit(direction.includes("w") ? rect.right - width : rect.left,
                        direction.includes("n") ? rect.bottom - height : rect.top);
                    return;
                }
                const minWidth = Math.min(610, Math.max(1, window.innerWidth - 2 * MARGIN));
                const maxWidth = Math.max(minWidth, edgeMax);
                const width = clamp(rect.width + (horizontal ? (direction.includes("e") ? dx : -dx) : 0), minWidth, maxWidth);
                const contentHeight = Math.max(measureStandardHug(), 1);
                const minHeight = Math.min(contentHeight, Math.max(1, window.innerHeight - 2 * MARGIN));
                const maxHeight = Math.max(minHeight, Math.min(window.innerHeight - 2 * MARGIN,
                    direction.includes("n") ? rect.bottom : window.innerHeight - rect.top));
                const height = !direction.includes("n") && !direction.includes("s")
                    ? rect.height
                    : clamp(rect.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0), minHeight, maxHeight);
                sizes.standard = { width, height, explicit: sizes.standard.explicit || direction.includes("n") || direction.includes("s") };
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
            if (docked) place();
            else {
                const rect = host.getBoundingClientRect();
                fit(rect.left, rect.top);
            }
        }, { signal });

        const typingTarget = (node) => node instanceof Element && !!node.closest("input, select, textarea, [contenteditable='true']");
        window.addEventListener("keydown", (ev) => {
            if (!studio || ev.repeat) return;
            if (ev.key === "Escape") {
                if (typingTarget(root.activeElement) || typingTarget(ev.target)) return;
                ev.preventDefault();
                ev.stopPropagation();
                if (!keys.hidden) toggleKeys(false);
                else exitStudio();
                return;
            }
            if (ev.key !== " " || ev.ctrlKey || ev.metaKey || ev.altKey) return;
            const focused = root.activeElement;
            if (typingTarget(focused) || typingTarget(ev.target) || focused instanceof HTMLButtonElement) return;
            ev.preventDefault();
            ev.stopPropagation();
            play.click();
        }, { capture: true, signal });
        document.addEventListener("fullscreenchange", () => {
            if (studio && document.fullscreenElement) exitStudio();
        }, { signal });

        document.documentElement.appendChild(host);
        setView(standard);
        place();
        render();
        renderMedia();
        resolveMedia();
        return { video, renderBadge, renderMedia, hasSegments: () => start !== null || segments.some(Boolean),
            show: () => {
                host.style.display = "";
                renderMedia();
                if (docked) place();
                else {
                    const rect = host.getBoundingClientRect();
                    fit(rect.left, rect.top);
                }
            },
            remove: () => { exitStudio(); events.abort(); host.remove(); } };
    }
})();
