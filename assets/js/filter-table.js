// Simple search box filter for a <table class="stats-table">.
// Pair with an <input id="table-search"> anywhere above the table.
// No dependencies, hides non-matching rows as you type.

document.addEventListener("DOMContentLoaded", function () {
    var input = document.getElementById("table-search");
    if (!input) return;

    var table = document.querySelector("table.stats-table");
    if (!table) return;

    var rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"));

    input.addEventListener("input", function () {
        var query = input.value.trim().toLowerCase();
        rows.forEach(function (row) {
            var text = row.textContent.toLowerCase();
            row.style.display = text.indexOf(query) === -1 ? "none" : "";
        });
    });
});
