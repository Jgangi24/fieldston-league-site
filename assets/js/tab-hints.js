// Adds a fade + chevron on the left/right edge of any scrollable tab strip
// (.section-tabs) when more tabs are hidden off-screen. Tapping a chevron
// scrolls the strip. Purely visual: the links work the same without it.
(function () {
    function setup(nav) {
        var wrap = document.createElement("div");
        wrap.className = "tabs-hint";
        nav.parentNode.insertBefore(wrap, nav);
        wrap.appendChild(nav);

        function makeButton(side, label, glyph) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "tabs-hint-btn tabs-hint-" + side;
            b.setAttribute("aria-label", label);
            b.textContent = glyph;
            b.hidden = true;
            b.addEventListener("click", function () {
                nav.scrollBy({ left: (side === "right" ? 1 : -1) * Math.max(120, nav.clientWidth * 0.6), behavior: "smooth" });
            });
            wrap.appendChild(b);
            return b;
        }
        var left = makeButton("left", "Scroll tabs left", "‹");
        var right = makeButton("right", "Scroll tabs right", "›");

        function update() {
            var max = nav.scrollWidth - nav.clientWidth;
            left.hidden = nav.scrollLeft <= 4;
            right.hidden = max <= 4 || nav.scrollLeft >= max - 4;
        }
        nav.addEventListener("scroll", update, { passive: true });
        window.addEventListener("resize", update);
        window.addEventListener("load", update);
        update();
    }

    function init() {
        Array.prototype.forEach.call(document.querySelectorAll("nav.section-tabs"), setup);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
