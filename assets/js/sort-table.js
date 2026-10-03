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
    var allRows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));

    // Roster tables have a "Bench" separator row with no stat cells. It
    // can't be sorted (and used to crash this function), so the rows above
    // and below it are sorted separately and the separator stays between
    // them -- starters stay starters, bench stays bench.
    var segments = [[]];
    var dividers = [];
    allRows.forEach(function (row) {
        if (row.classList.contains("bench-divider") || row.classList.contains("ir-divider")) {
            dividers.push(row);
            segments.push([]);
        } else {
            segments[segments.length - 1].push(row);
        }
    });
    var rows = [].concat.apply([], segments);

    var currentlyAscending = th.classList.contains("sort-asc");
    headers.forEach(function (h) {
        h.classList.remove("sort-asc", "sort-desc");
    });
    var ascending = !currentlyAscending;
    th.classList.add(ascending ? "sort-asc" : "sort-desc");

    function cellValue(row) {
        var cell = row.children[colIndex];
        return cell.getAttribute("data-value") || cell.textContent.trim();
    }

    var isNumeric = rows.every(function (row) {
        var cellText = cellValue(row);
        return cellText === "" || !isNaN(parseFloat(cellText));
    });

    function compare(a, b) {
        var aVal = cellValue(a);
        var bVal = cellValue(b);
        if (isNumeric) {
            aVal = parseFloat(aVal) || 0;
            bVal = parseFloat(bVal) || 0;
            return ascending ? aVal - bVal : bVal - aVal;
        }
        return ascending
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
    }

    // Batch all the moves into one DOM operation instead of one per row —
    // moving rows one at a time forces the browser to recalculate layout
    // after each move, which gets very slow on large tables.
    var fragment = document.createDocumentFragment();
    segments.forEach(function (segment, i) {
        segment.sort(compare).forEach(function (row) {
            fragment.appendChild(row);
        });
        if (dividers[i]) fragment.appendChild(dividers[i]);
    });
    tbody.appendChild(fragment);
}
