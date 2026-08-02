// Lets GMs drag roster rows to try out different starter/bench arrangements.
// This is visual-only -- nothing here saves anywhere or changes your real
// BBGM league. Reordering resets the moment the page is reloaded.
document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('table.roster-table tbody').forEach(function (tbody) {
        let draggedRow = null;

        tbody.querySelectorAll('tr[draggable="true"]').forEach(function (row) {
            row.addEventListener('dragstart', function () {
                draggedRow = row;
                row.classList.add('dragging');
            });
            row.addEventListener('dragend', function () {
                row.classList.remove('dragging');
                draggedRow = null;
            });
        });

        tbody.addEventListener('dragover', function (e) {
            e.preventDefault();
            if (!draggedRow) return;
            const afterRow = getDragAfterElement(tbody, e.clientY);
            if (afterRow == null) {
                tbody.appendChild(draggedRow);
            } else {
                tbody.insertBefore(draggedRow, afterRow);
            }
            repositionDivider(tbody);
        });
    });

    // Keeps the "Bench" divider locked to the 5/6 boundary -- always
    // exactly 5 draggable rows above it, no matter how rows get
    // reordered. If a roster has fewer than 6 players, there's no
    // divider row to reposition, and this safely does nothing.
    function repositionDivider(tbody) {
        const divider = tbody.querySelector('.bench-divider');
        if (!divider) return;
        const rows = [...tbody.querySelectorAll('tr[draggable="true"]')];
        const sixthRow = rows[5];
        if (sixthRow) {
            tbody.insertBefore(divider, sixthRow);
        } else {
            tbody.appendChild(divider);
        }
    }

    function getDragAfterElement(container, y) {
        const rows = [...container.querySelectorAll('tr[draggable="true"]:not(.dragging)')];
        return rows.reduce(
            (closest, row) => {
                const box = row.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) {
                    return { offset: offset, element: row };
                }
                return closest;
            },
            { offset: Number.NEGATIVE_INFINITY, element: null }
        ).element;
    }
});
