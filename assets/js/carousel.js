// News carousel: auto-rotates every 6 seconds, and lets the user click
// the chevrons or dots to jump directly. Manual interaction resets the
// auto-rotate timer, so it doesn't jump to a new story right after
// someone clicked to one on purpose.

document.addEventListener('DOMContentLoaded', function () {
    var carousel = document.querySelector('.carousel');
    if (!carousel) return;

    var slides = carousel.querySelectorAll('.carousel-slide');
    var dots = carousel.querySelectorAll('.carousel-dot');
    var prevBtn = carousel.querySelector('.carousel-arrow-prev');
    var nextBtn = carousel.querySelector('.carousel-arrow-next');
    var current = 0;
    var timer = null;
    var AUTO_ROTATE_MS = 6000;

    function show(index) {
        current = (index + slides.length) % slides.length;
        slides.forEach(function (slide, i) {
            slide.classList.toggle('active', i === current);
        });
        dots.forEach(function (dot, i) {
            dot.classList.toggle('active', i === current);
        });
    }

    function startTimer() {
        if (timer) clearInterval(timer);
        timer = setInterval(function () { show(current + 1); }, AUTO_ROTATE_MS);
    }

    function goTo(index) {
        show(index);
        startTimer(); // manual interaction resets the auto-rotate clock
    }

    if (prevBtn) prevBtn.addEventListener('click', function () { goTo(current - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { goTo(current + 1); });
    dots.forEach(function (dot, i) {
        dot.addEventListener('click', function () { goTo(i); });
    });

    show(0);
    startTimer();
});
