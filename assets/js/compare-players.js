// Compare Players: pick 2-5 players, see ratings + season stats side by
// side, with the best value in each row highlighted. Player data and the
// ratings row list are embedded in the page (see build_compare_players.py)
// rather than fetched, so this runs entirely offline against what's
// already in the HTML.

document.addEventListener("DOMContentLoaded", function () {
    const MAX_PLAYERS = 5;
    const MIN_PLAYERS = 2;

    const dataEl = document.getElementById("compare-data");
    const ratingRowsEl = document.getElementById("compare-rating-rows");
    if (!dataEl || !ratingRowsEl) return;

    const PLAYERS = JSON.parse(dataEl.textContent);
    const RATING_ROWS = JSON.parse(ratingRowsEl.textContent); // [[key, abbrev, label], ...]

    // [key, label, higherIsBetter]. higherIsBetter === null means
    // informational only -- never highlighted.
    const STAT_ROWS = [
        ["gp", "GP", null],
        ["min", "MIN", null],
        ["pts", "PTS", true],
        ["trb", "REB", true],
        ["ast", "AST", true],
        ["stl", "STL", true],
        ["blk", "BLK", true],
        ["tov", "TOV", false],
        ["fg_pct", "FG%", true],
        ["fg3_pct", "3P%", true],
        ["ft_pct", "FT%", true],
        ["game_score", "GmSc", true],
        ["plus_minus", "+/-", true],
    ];

    const byPid = {};
    PLAYERS.forEach(p => { byPid[p.pid] = p; });

    // Group for <optgroup>: one group per real team abbrev, then Free agents.
    const teams = [...new Set(PLAYERS.filter(p => p.team !== "Free agent").map(p => p.team))].sort();
    const groups = teams.map(t => [t, PLAYERS.filter(p => p.team === t)]);
    groups.push(["Free agents", PLAYERS.filter(p => p.team === "Free agent")]);

    // Start with the first two players in the list (alphabetical) in the two slots.
    let active = [PLAYERS[0].pid, PLAYERS[1].pid];

    const selectorsEl = document.getElementById("compare-selectors");
    const addBtn = document.getElementById("compare-add-btn");
    const tableEl = document.getElementById("compare-table");

    function renderSelectors() {
        selectorsEl.innerHTML = "";
        active.forEach((pid, slot) => {
            const wrap = document.createElement("div");
            wrap.className = "compare-select-wrap";

            const select = document.createElement("select");
            select.className = "compare-select";
            groups.forEach(([groupName, groupPlayers]) => {
                if (!groupPlayers.length) return;
                const optgroup = document.createElement("optgroup");
                optgroup.label = groupName;
                groupPlayers.forEach(p => {
                    const opt = document.createElement("option");
                    opt.value = p.pid;
                    opt.textContent = p.name;
                    if (p.pid === pid) opt.selected = true;
                    optgroup.appendChild(opt);
                });
                select.appendChild(optgroup);
            });
            select.addEventListener("change", function (e) {
                active[slot] = Number(e.target.value);
                renderTable();
            });
            wrap.appendChild(select);

            if (active.length > MIN_PLAYERS) {
                const removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className = "compare-remove-btn";
                removeBtn.setAttribute("aria-label", "Remove player");
                removeBtn.textContent = "\u00d7";
                removeBtn.addEventListener("click", function () {
                    active.splice(slot, 1);
                    renderSelectors();
                    renderTable();
                });
                wrap.appendChild(removeBtn);
            }

            selectorsEl.appendChild(wrap);
        });

        addBtn.style.display = active.length >= MAX_PLAYERS ? "none" : "";
    }

    function cellDisplay(value, suffix) {
        if (value === null || value === undefined) return "&ndash;";
        return suffix ? `${value}${suffix}` : `${value}`;
    }

    function renderSection(sectionLabel, rows, valueGetter, players, colCount) {
        let html = `<tr class="compare-section-row"><td colspan="${colCount}">${sectionLabel}</td></tr>`;
        rows.forEach(([key, label, higherIsBetter, suffix]) => {
            const values = players.map(p => valueGetter(p, key));
            let best = null;
            if (higherIsBetter !== null) {
                const numeric = values.filter(v => v !== null && v !== undefined);
                if (numeric.length) {
                    best = higherIsBetter ? Math.max(...numeric) : Math.min(...numeric);
                }
            }
            html += `<tr><td class="compare-row-label">${label}</td>`;
            players.forEach(p => {
                const v = valueGetter(p, key);
                const isBest = best !== null && v === best;
                html += `<td class="${isBest ? "compare-best" : ""}">${cellDisplay(v, suffix)}</td>`;
            });
            html += "</tr>";
        });
        return html;
    }

    function renderTable() {
        const players = active.map(pid => byPid[pid]);
        const colCount = players.length + 1;

        let html = "<thead><tr><th></th>";
        players.forEach(p => {
            html += `<th>${p.name}<div class="compare-subhead">${p.pos} &middot; ${p.team}</div></th>`;
        });
        html += "</tr></thead><tbody>";

        html += renderSection(
            "Ratings",
            RATING_ROWS.map(([key, abbrev, label]) => [key, `<abbr title="${label}">${abbrev}</abbr>`, true]),
            (p, key) => p.ratings[key],
            players,
            colCount,
        );

        html += renderSection(
            "Stats",
            STAT_ROWS.map(([key, label, higherIsBetter]) => {
                const suffix = (key === "fg_pct" || key === "fg3_pct" || key === "ft_pct") ? "%" : null;
                return [key, label, higherIsBetter, suffix];
            }),
            (p, key) => p.stats[key],
            players,
            colCount,
        );

        html += "</tbody>";
        tableEl.innerHTML = html;
    }

    addBtn.addEventListener("click", function () {
        if (active.length >= MAX_PLAYERS) return;
        const next = PLAYERS.find(p => !active.includes(p.pid));
        active.push(next ? next.pid : PLAYERS[0].pid);
        renderSelectors();
        renderTable();
    });

    renderSelectors();
    renderTable();
});
