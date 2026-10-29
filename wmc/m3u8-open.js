// [WMC] 仅当整段下载带 wmcMp4=1 时套用这一次的解析页默认项。手动点放大镜不受影响。
(() => {
    if (new URLSearchParams(location.search).get("wmcMp4") !== "1") return;
    const off = ["ffmpeg", "StreamTest", "onlyAudio", "saveAs", "autoClose"];
    const timer = setInterval(() => {
        const mp4 = document.querySelector("#mp4");
        const stream = document.querySelector("#StreamSaver");
        const prep = document.querySelector("#dataPreprocessing");
        const thread = document.querySelector("#thread");
        if (!mp4 || !stream || !prep || !thread) return;
        thread.value = "6";
        for (const id of off) {
            const box = document.querySelector("#" + id);
            if (box && box.checked) box.click();
        }
        if (!mp4.checked) mp4.click();
        if (!stream.checked) stream.click();
        if (!prep.checked) prep.click();
    }, 50);
    setTimeout(() => clearInterval(timer), 15000);
})();
