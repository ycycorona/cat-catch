// [WMC] 骨架：只应答 wmc 前缀消息，其他消息不回应也不吞掉应答权
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message === "string" && message.startsWith("wmc")) {
        sendResponse({ ok: true });
    }
});
