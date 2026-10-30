// [WMC] 仅给当前网页恢复浮窗；不使用上游媒体控制面板保存的目标。
(() => {
    const button = document.getElementById("wmc-open-overlay");
    const error = document.getElementById("wmc-open-error");
    const autoShow = document.getElementById("wmc-auto-overlay");
    const msg = (key) => chrome.i18n.getMessage(key);
    const showError = (key) => {
        error.textContent = msg(key);
        error.hidden = false;
    };
    button.textContent = msg("wmc_openOverlay");
    autoShow.nextElementSibling.textContent = msg("wmc_autoShowOverlay");
    chrome.storage.local.get({ wmcAutoShow: false }, (settings) => {
        if (chrome.runtime.lastError) showError("wmc_overlaySettingFailed");
        else autoShow.checked = settings.wmcAutoShow === true;
        autoShow.disabled = false;
    });
    autoShow.addEventListener("change", async () => {
        const enabled = autoShow.checked;
        autoShow.disabled = true;
        error.hidden = true;
        try {
            await chrome.storage.local.set({ wmcAutoShow: enabled });
        } catch {
            autoShow.checked = !enabled;
            showError("wmc_overlaySettingFailed");
        } finally {
            autoShow.disabled = false;
        }
    });
    button.addEventListener("click", async () => {
        button.disabled = true;
        error.textContent = "";
        error.hidden = true;
        try {
            const requestedTab = Number(new URLSearchParams(location.search).get("tabId"));
            const tabId = requestedTab > 0 ? requestedTab : G.tabId;
            if (!(tabId > 0)) throw new Error("wmc_cannotOpenOverlay");
            const frames = await chrome.webNavigation.getAllFrames({ tabId });
            const states = (await Promise.all((frames || []).map(async ({ frameId }) => {
                try {
                    const state = await chrome.tabs.sendMessage(tabId, { Message: "wmcGetOverlayState" }, { frameId });
                    return state ? { ...state, frameId } : null;
                } catch { return null; }
            }))).filter(Boolean);
            if (!states.length) throw new Error("wmc_cannotOpenOverlay");
            const candidates = states.filter((state) => state.available).sort((a, b) =>
                Number(b.bound) - Number(a.bound) || Number(b.playing) - Number(a.playing) ||
                b.latestPlayedAt - a.latestPlayedAt || a.frameId - b.frameId);
            if (!candidates.length) throw new Error("wmc_noVideo");
            const result = await chrome.tabs.sendMessage(tabId, { Message: "wmcShowOverlay" }, { frameId: candidates[0].frameId });
            if (!result?.ok) throw new Error(result?.reason === "wmc_noVideo" ? "wmc_noVideo" : "wmc_cannotOpenOverlay");
            window.close();
        } catch (failure) {
            showError(failure.message === "wmc_noVideo" ? "wmc_noVideo" : "wmc_cannotOpenOverlay");
        } finally {
            button.disabled = false;
        }
    });
})();
