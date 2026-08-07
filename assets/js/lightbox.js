// Click-to-expand lightbox for article images (hero + photo strip).
// Any <img class="lightbox-trigger"> on the page will open full-size in an
// overlay on click. Click the image again, click outside it, click the
// close button, or press Escape to dismiss.

document.addEventListener("DOMContentLoaded", function () {
    var triggers = document.querySelectorAll(".lightbox-trigger");
    if (!triggers.length) return;

    var overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    overlay.innerHTML =
        '<button class="lightbox-close" aria-label="Close">&times;</button>' +
        '<img src="" alt="">';
    document.body.appendChild(overlay);

    var overlayImg = overlay.querySelector("img");
    var closeBtn = overlay.querySelector(".lightbox-close");

    function openLightbox(src, alt) {
        overlayImg.src = src;
        overlayImg.alt = alt || "";
        overlay.classList.add("active");
        document.body.style.overflow = "hidden";
    }

    function closeLightbox() {
        overlay.classList.remove("active");
        document.body.style.overflow = "";
    }

    triggers.forEach(function (img) {
        img.addEventListener("click", function () {
            openLightbox(img.getAttribute("src"), img.getAttribute("alt"));
        });
    });

    overlay.addEventListener("click", function (e) {
        if (e.target === overlay || e.target === overlayImg) {
            closeLightbox();
        }
    });

    closeBtn.addEventListener("click", closeLightbox);

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeLightbox();
    });
});
