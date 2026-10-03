// Full-screen splash shown once per visit (the first page you open after arriving or
// reopening the app), then fades out. Tap anywhere to skip. Phones get the portrait
// image, bigger screens get the wide one. Never blocks the page: if anything goes wrong
// it simply doesn't show.
(function () {
    try {
        if (sessionStorage.getItem("fcf-splash")) return;
        sessionStorage.setItem("fcf-splash", "1");
    } catch (e) { return; }   // storage blocked (private mode): skip rather than flash on every page

    var script = document.currentScript;
    if (!script || !script.src) return;
    var base = script.src.replace(/js\/splash\.js.*$/, "images/app/");
    var phone = window.innerWidth < 700 || window.innerHeight > window.innerWidth;
    var image = base + (phone ? "splash-mobile.jpg" : "splash-desktop.jpg");

    var css = document.createElement("style");
    css.textContent =
        "#fcf-splash{position:fixed;inset:0;z-index:99999;background:#05070d url('" + image + "') center/" +
        (phone ? "cover" : "contain") + " no-repeat;cursor:pointer;transition:opacity .5s ease;opacity:1}" +
        "#fcf-splash.fcf-out{opacity:0;pointer-events:none}";
    var el = document.createElement("div");
    el.id = "fcf-splash";
    el.setAttribute("aria-hidden", "true");

    var preload = new Image();   // don't show an empty dark box while the picture loads
    preload.src = image;

    function hide() {
        el.classList.add("fcf-out");
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
    }
    // This script runs in <head>, before <body> exists, so attach to <html> to cover the
    // page from the very first paint.
    document.head.appendChild(css);
    document.documentElement.appendChild(el);
    el.addEventListener("click", hide);
    setTimeout(hide, 2200);
})();
