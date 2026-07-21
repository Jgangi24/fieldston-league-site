// Tiny click-to-sort for any <table class="stats-table">.
// No dependencies. Numeric columns sort numerically, everything else sorts as text.

document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("table.stats-table").forEach(function (table) {
        var headers = table.querySelectorAll("thead th");
        headers.forEach(function (th, colIndex) {
            th.addEventListener("click", function () {
                sortTableByColumn(table, colIndex, th, headers);
            });
        });
    });
});

function sortTableByColumn(table, colIndex, th, headers) {
    var tbody = table.querySelector("tbody");
    var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));

    var currentlyAscending = th.classList.contains("sort-asc");
    headers.forEach(function (h) {
        h.classList.remove("sort-asc", "sort-desc");
    });
    var ascending = !currentlyAscending;
    th.classList.add(ascending ? "sort-asc" : "sort-desc");

    var isNumeric = rows.every(function (row) {
        var cellText = row.children[colIndex].getAttribute("data-value")
            || row.children[colIndex].textContent.trim();
        return cellText === "" || !isNaN(parseFloat(cellText));
    });

    rows.sort(function (a, b) {
        var aCell = a.children[colIndex];
        var bCell = b.children[colIndex];
        var aVal = aCell.getAttribute("data-value") || aCell.textContent.trim();
        var bVal = bCell.getAttribute("data-value") || bCell.textContent.trim();

        if (isNumeric) {
            aVal = parseFloat(aVal) || 0;
            bVal = parseFloat(bVal) || 0;
            return ascending ? aVal - bVal : bVal - aVal;
        }
        return ascending
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
    });

    // Batch all the moves into one DOM operation instead of one per row —
    // moving rows one at a time forces the browser to recalculate layout
    // after each move, which gets very slow on large tables.
    var fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
        fragment.appendChild(row);
    });
    tbody.appendChild(fragment);
}
