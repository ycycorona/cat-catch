// [WMC] SPEC-001 T2：悬浮控制器（closed shadow root，单段标记）
// 第二段/绑定切换在 T4，下载提交在 T6；本文件不读写 G/cacheData，不调用上游函数。
(() => {
    if (window.__wmcOverlay) return;
    window.__wmcOverlay = true;

    const MIN_DURATION = 10;
    const BAR_WIDTH = 340;
    const MARGIN = 16;
    const seen = new WeakSet();
    let mounted = false;

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
        if (mounted || seen.has(video)) return;
        if (!isFinite(video.duration) || video.duration < MIN_DURATION) return;
        seen.add(video);
        mounted = true;
        mount(video);
    }

    document.addEventListener("play", (e) => {
        const video = e.target;
        if (!(video instanceof HTMLVideoElement) || mounted || seen.has(video)) return;
        if (isFinite(video.duration)) {
            tryMount(video);
        } else {
            video.addEventListener("loadedmetadata", () => tryMount(video), { once: true });
        }
    }, true);

    function mount(video) {
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
            .seg { position: absolute; top: -5px; height: 6px; border-radius: 3px; background: #3b82f6; }
            .seg.pending { opacity: .6; }
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
                <div class="track"><div class="rail"><div class="seg"></div></div><div class="head"></div></div>
                <button class="add" type="button">＋</button>
                <button class="dl" type="button">↓</button>
                <div class="hint" role="status" aria-live="polite"></div>
            </div>`;

        const handle = root.querySelector(".handle");
        const play = root.querySelector(".play");
        const time = root.querySelector(".time");
        const track = root.querySelector(".track");
        const segEl = root.querySelector(".seg");
        const head = root.querySelector(".head");
        const add = root.querySelector(".add");
        const dl = root.querySelector(".dl");
        const hint = root.querySelector(".hint");

        play.setAttribute("aria-label", msg("wmc_play"));
        add.setAttribute("aria-label", msg("wmc_addSegment"));
        dl.setAttribute("aria-label", msg("wmc_download"));

        let start = null; // 待定起点
        let seg = null;   // 已完成单段 { start, end }

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
            let block = null;
            if (seg) {
                block = { start: seg.start, end: seg.end, pending: false };
            } else if (start !== null) {
                // 段块随播放头延伸
                block = { start, end: Math.max(start, Math.min(video.currentTime, duration)), pending: true };
            }
            if (block) {
                segEl.style.opacity = "1";
                segEl.classList.toggle("pending", block.pending);
                segEl.style.left = `${pct(block.start, duration)}%`;
                segEl.style.width = `${pct(block.end, duration) - pct(block.start, duration)}%`;
            } else {
                segEl.style.opacity = "0";
            }
            add.disabled = !!seg; // 第二段在 T4
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
                start = now;
            } else if (now > start) {
                seg = { start, end: now };
                start = null;
                showHint("");
            }
            // 终点 ≤ 起点：不生成选段，起点保持待定
            render();
        });

        dl.addEventListener("click", () => {
            // T6 才接提交；本卡只保证待定态不提交任何下载任务
            if (start !== null) showHint(msg("wmc_needEnd"));
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
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
        });

        const seekTo = (clientX) => {
            const rect = track.getBoundingClientRect();
            if (!(rect.width > 0) || !isFinite(video.duration)) return;
            video.currentTime = clamp((clientX - rect.left) / rect.width, 0, 1) * video.duration;
        };
        track.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            seekTo(e.clientX);
            const move = (ev) => seekTo(ev.clientX);
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
        });

        for (const type of ["play", "pause", "timeupdate", "seeked", "durationchange", "loadedmetadata"]) {
            video.addEventListener(type, render);
        }
        window.addEventListener("resize", place);

        document.documentElement.appendChild(host);
        place();
        render();
    }
})();
