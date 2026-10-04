// Commissioner dashboard (admin.html). Shows every GM's requests for a
// week in one place, resolves contested waiver claims by priority, and
// lets the commissioner tick requests off as "applied" once they've been
// re-entered in BBGM by hand. Also owns the IR-eligibility flags GMs can't
// set themselves. Nothing here touches BBGM.
(async function () {
    await window.Portal.ready;

    document.addEventListener("portal:auth-changed", function () {
        window.location.reload();
    });

    var root = document.getElementById("admin-root");
    var user = window.Portal.getUser();

    if (!user) return showMessage("Sign in as the commissioner (top right) to use this page.");
    if (!user.is_commissioner) return showMessage("This page is for the commissioner only.");

    var client = window.Portal.getClient();

    function showMessage(text) {
        root.innerHTML = "<h1>Commissioner Dashboard</h1>";
        var p = document.createElement("p");
        p.className = "placeholder";
        p.textContent = text;
        root.appendChild(p);
    }

    // ---- Reference data (teams, GMs, players), loaded once --------------

    var refs = await Promise.all([
        client.from("teams_mirror").select("tid,abbrev,full_name,gm_id").order("tid"),
        client.from("gms").select("id,name"),
        client.from("players_mirror").select("pid,first_name,last_name,tid,ir_eligible,roster_order,pt_modifier,injury_status").limit(2000),
        client.from("sync_state").select("current_week_number").eq("id", 1).single(),
    ]);
    if (refs.some(function (r) { return r.error; })) {
        console.error("Portal admin: failed to load reference data", refs);
        return showMessage("Couldn't load league data -- check your connection and refresh.");
    }

    var teams = refs[0].data;
    var teamByTid = {};
    teams.forEach(function (t) { teamByTid[t.tid] = t; });
    var gmNameById = {};
    refs[1].data.forEach(function (g) { gmNameById[g.id] = g.name; });
    var players = refs[2].data;
    var playerByPid = {};
    players.forEach(function (p) { playerByPid[p.pid] = p; });
    var currentWeek = refs[3].data ? refs[3].data.current_week_number : 0;
    if (!currentWeek) return showMessage("No weekly sync has run yet -- there's nothing to manage.");

    var state = { week: currentWeek, showApplied: false };
    var lineupRows = [];

    // ---- Small helpers --------------------------------------------------

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function playerName(pid) {
        var p = playerByPid[pid];
        return p ? (p.first_name + " " + p.last_name).trim() : "Player #" + pid;
    }

    function teamLabel(tid) {
        var t = teamByTid[tid];
        if (!t) return "Team " + tid;
        return t.abbrev + (t.gm_id && gmNameById[t.gm_id] ? " (" + gmNameById[t.gm_id] + ")" : "");
    }

    function badge(status) {
        return el("span", "admin-badge admin-badge-" + status, status);
    }

    function button(label, className, onClick) {
        var b = el("button", className || "admin-btn", label);
        b.type = "button";
        b.addEventListener("click", onClick);
        return b;
    }

    var toastEl = null;
    var toastTimer = null;
    function toast(text, kind) {
        if (!toastEl) {
            toastEl = el("div", "portal-toast");
            toastEl.setAttribute("role", "status");
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.className = "portal-toast is-visible" + (kind ? " is-" + kind : "");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, kind === "error" ? 5000 : 2000);
    }

    // Applying is allowed once a request is "won". Non-waiver requests
    // (lineup, PT, IR) have nothing to contest, so they can be applied
    // straight from "pending" too.
    function canApply(req) {
        return req.status === "won" || (req.status === "pending" && req.type !== "add_drop");
    }

    async function markApplied(reqs) {
        var ids = reqs.filter(canApply).map(function (r) { return r.id; });
        if (!ids.length) return;
        var result = await client.from("gm_requests")
            .update({ status: "applied", applied_at: new Date().toISOString(), applied_by: user.id })
            .in("id", ids);
        if (result.error) {
            console.error("Portal admin: mark applied failed", result.error);
            toast("Couldn't save -- try again.", "error");
            return;
        }
        toast("Marked applied ✓", "ok");
        render();
    }

    function confirmDialog(title, message, yesLabel) {
        return new Promise(function (resolve) {
            var backdrop = el("div", "roster-picker-backdrop");
            var dialog = el("div", "roster-picker");
            dialog.setAttribute("role", "dialog");
            var header = el("div", "roster-picker-header");
            var box = el("div");
            box.appendChild(el("h3", "", title));
            box.appendChild(el("p", "roster-picker-sub", message));
            header.appendChild(box);
            var actions = el("div", "roster-confirm-actions");
            function done(value) {
                backdrop.remove();
                resolve(value);
            }
            actions.appendChild(button("Cancel", "roster-confirm-no", function () { done(false); }));
            actions.appendChild(button(yesLabel, "roster-confirm-yes", function () { done(true); }));
            dialog.appendChild(header);
            dialog.appendChild(actions);
            backdrop.appendChild(dialog);
            backdrop.addEventListener("click", function (e) { if (e.target === backdrop) done(false); });
            document.body.appendChild(backdrop);
        });
    }

    // ---- Rendering -------------------------------------------------------

    async function render() {
        var results = await Promise.all([
            client.from("gm_requests").select("id,gm_id,tid,type,status,payload,submitted_at").eq("week_number", state.week).order("submitted_at"),
            client.from("waiver_priority").select("tid,priority_rank").eq("week_number", state.week),
            client.from("lineup_state").select("pid,tid,pt_level,roster_order"),
        ]);
        if (results[0].error || results[1].error || results[2].error) {
            console.error("Portal admin: load failed", results);
            return showMessage("Couldn't load this week's requests -- check your connection and refresh.");
        }

        var allRequests = results[0].data;
        lineupRows = results[2].data;
        var rankByTid = {};
        results[1].data.forEach(function (w) { rankByTid[w.tid] = w.priority_rank; });

        var visible = allRequests.filter(function (r) {
            if (r.status === "cancelled") return false;
            return state.showApplied || r.status !== "applied";
        });

        root.innerHTML = "";
        root.appendChild(el("h1", "", "Commissioner Dashboard"));
        root.appendChild(renderToolbar(allRequests, visible, rankByTid));

        var addDrops = visible.filter(function (r) { return r.type === "add_drop"; });
        var irToggles = visible.filter(function (r) { return r.type === "ir_toggle"; });

        if (!visible.length) {
            var none = el("div", "card");
            none.appendChild(el("p", "placeholder", "Nothing waiting on you for Week " + state.week + "."));
            root.appendChild(none);
        }

        root.appendChild(renderAddDrops(addDrops, rankByTid));
        root.appendChild(renderLineups());
        root.appendChild(renderIrToggles(irToggles));
        root.appendChild(renderIrEligibility());
    }

    // Week 14 is the last regular-season week and runs past a normal 7 days, so it
    // is played with BBGM's "Until playoffs" instead of "One week". Remind the
    // commissioner from the week before.
    function seasonReminder() {
        if (currentWeek === 13) {
            return "Heads up: after this week, Week 14 is the last week of the season. Sim it with Play \u2192 Until playoffs (not One week).";
        }
        if (currentWeek === 14) {
            return "Next sim is Week 14, the last regular-season week: in BBGM choose Play \u2192 Until playoffs (not One week).";
        }
        if (currentWeek >= 15) {
            return "The regular season is complete. Playoffs are next.";
        }
        return null;
    }

    function renderToolbar(allRequests, visible, rankByTid) {
        var card = el("div", "card admin-toolbar");

        var reminder = seasonReminder();
        if (reminder) card.appendChild(el("p", "admin-reminder", reminder));

        var weekRow = el("div", "admin-row");
        var prev = button("◀", "admin-btn admin-btn-ghost", function () { state.week--; render(); });
        prev.disabled = state.week <= 1;
        var next = button("▶", "admin-btn admin-btn-ghost", function () { state.week++; render(); });
        next.disabled = state.week >= currentWeek;
        weekRow.appendChild(prev);
        weekRow.appendChild(el("strong", "admin-week", "Week " + state.week));
        weekRow.appendChild(next);
        var label = el("label", "admin-check");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = state.showApplied;
        cb.addEventListener("change", function () { state.showApplied = cb.checked; render(); });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" Show applied"));
        weekRow.appendChild(label);
        card.appendChild(weekRow);

        var pendingCount = allRequests.filter(function (r) { return r.status === "pending"; }).length;
        var applyable = visible.filter(canApply);

        var actions = el("div", "admin-row");
        var resolveBtn = button("Resolve Waivers", "admin-btn", async function () {
            var ok = await confirmDialog(
                "Resolve Week " + state.week + " waivers?",
                "Contested add/drop claims go to the team with the best waiver priority; every other pending request is approved. " +
                pendingCount + " pending request" + (pendingCount === 1 ? "" : "s") + " will change status.",
                "Resolve"
            );
            if (!ok) return;
            var result = await client.rpc("resolve_waivers", { p_week_number: state.week });
            if (result.error) {
                console.error("Portal admin: resolve failed", result.error);
                toast("Couldn't resolve -- try again.", "error");
                return;
            }
            toast("Waivers resolved ✓", "ok");
            render();
        });
        resolveBtn.disabled = !pendingCount;
        actions.appendChild(resolveBtn);

        var allBtn = button("Mark all applied (" + applyable.length + ")", "admin-btn admin-btn-secondary", async function () {
            var ok = await confirmDialog("Mark everything applied?", "This marks " + applyable.length + " request" + (applyable.length === 1 ? "" : "s") + " as entered in BBGM.", "Mark applied");
            if (ok) markApplied(applyable);
        });
        allBtn.disabled = !applyable.length;
        actions.appendChild(allBtn);
        card.appendChild(actions);

        var order = Object.keys(rankByTid).sort(function (a, b) { return rankByTid[a] - rankByTid[b]; });
        if (order.length) {
            card.appendChild(el("p", "admin-note", "Waiver order: " + order.map(function (tid, i) {
                return (i + 1) + ". " + teamLabel(parseInt(tid, 10));
            }).join("  ·  ")));
        }
        return card;
    }

    function renderAddDrops(addDrops, rankByTid) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "Add / Drop Claims"));
        if (!addDrops.length) {
            card.appendChild(el("p", "placeholder", "No claims."));
            return card;
        }

        var groups = {};
        addDrops.forEach(function (r) {
            var key = r.payload.add_pid || "drop-only-" + r.id;
            (groups[key] = groups[key] || []).push(r);
        });

        Object.keys(groups).forEach(function (key) {
            var claims = groups[key].slice().sort(function (a, b) {
                return (rankByTid[a.tid] || 99) - (rankByTid[b.tid] || 99);
            });
            var contested = claims.length > 1;
            var group = el("div", "admin-group" + (contested ? " admin-contested" : ""));

            var title = el("div", "admin-group-title");
            var first = claims[0].payload;
            title.appendChild(el("strong", "", first.add_pid ? "Add " + playerName(first.add_pid) : "Drop only"));
            if (contested) title.appendChild(el("span", "admin-badge admin-badge-contested", claims.length + " teams want this player"));
            group.appendChild(title);

            var anyPending = claims.some(function (c) { return c.status === "pending"; });
            claims.forEach(function (claim, i) {
                var row = el("div", "admin-line");
                var text = el("span", "admin-line-text");
                text.textContent = teamLabel(claim.tid) + " — drop " + playerName(claim.payload.drop_pid) +
                    (rankByTid[claim.tid] ? " — priority #" + rankByTid[claim.tid] : "");
                row.appendChild(text);
                if (contested && anyPending && claim.status === "pending" && i === 0) {
                    row.appendChild(el("span", "admin-badge admin-badge-won", "would win"));
                }
                row.appendChild(badge(claim.status));
                if (canApply(claim)) {
                    row.appendChild(button("Mark applied", "admin-btn admin-btn-small", function () { markApplied([claim]); }));
                }
                group.appendChild(row);
            });
            card.appendChild(group);
        });
        return card;
    }

    // BBGM's own current order for a team (from the last sync), as pids.
    function bbgmOrder(tid) {
        return players
            .filter(function (p) { return p.tid === tid; })
            .sort(function (a, b) { return (a.roster_order || 0) - (b.roster_order || 0); })
            .map(function (p) { return p.pid; });
    }

    var PT_BY_MODIFIER = [[0, "0"], [0.75, "-"], [1, "normal"], [1.25, "+"], [1.75, "++"]];
    function bbgmPtLevel(modifier) {
        var m = parseFloat(modifier);
        if (isNaN(m)) m = 1;
        var best = PT_BY_MODIFIER[0];
        PT_BY_MODIFIER.forEach(function (pair) { if (Math.abs(pair[0] - m) < Math.abs(best[0] - m)) best = pair; });
        return best[1];
    }

    // GMs' lineup and PT choices save instantly (no approval). This lists, per
    // team, only what still differs from BBGM's last export -- i.e. what the
    // commissioner has left to enter. It empties itself after the next sync.
    function renderLineups() {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "Lineups & Playing Time to enter in BBGM"));
        var any = false;

        teams.forEach(function (t) {
            var tid = t.tid;
            var mine = lineupRows.filter(function (r) { return r.tid === tid; });
            var orderByPid = {};
            mine.forEach(function (r) { if (r.roster_order !== null && r.roster_order !== undefined) orderByPid[r.pid] = r.roster_order; });
            var ptChanges = mine.filter(function (r) {
                var p = playerByPid[r.pid];
                return r.pt_level && p && p.tid === tid && r.pt_level !== bbgmPtLevel(p.pt_modifier);
            });

            var current = bbgmOrder(tid);
            var wanted = current.slice();
            if (Object.keys(orderByPid).length) {
                wanted.sort(function (a, b) {
                    var av = orderByPid[a], bv = orderByPid[b];
                    if (av === undefined && bv === undefined) return current.indexOf(a) - current.indexOf(b);
                    if (av === undefined) return 1;
                    if (bv === undefined) return -1;
                    return av - bv;
                });
            }
            var orderChanged = wanted.some(function (pid, i) { return pid !== current[i]; });
            if (!orderChanged && !ptChanges.length) return;
            any = true;

            var group = el("div", "admin-group");
            var title = el("div", "admin-group-title");
            title.appendChild(el("strong", "", teamLabel(tid)));
            group.appendChild(title);
            if (orderChanged) {
                var names = wanted.map(playerName);
                group.appendChild(lineText("Starters", names.slice(0, 5).join(", ")));
                if (names.length > 5) group.appendChild(lineText("Bench", names.slice(5).join(", ")));
            }
            ptChanges.forEach(function (r) {
                var level = r.pt_level === "normal" ? "\u2713" : r.pt_level;
                group.appendChild(lineText("Playing time", playerName(r.pid) + " \u2192 " + level));
            });
            card.appendChild(group);
        });

        if (!any) card.appendChild(el("p", "placeholder", "Nothing to enter -- BBGM matches every GM's lineup and playing time."));
        return card;
    }

    function lineText(label, text) {
        var p = el("p", "admin-line-p");
        p.appendChild(el("strong", "", label + ": "));
        p.appendChild(document.createTextNode(text));
        return p;
    }

    function renderIrToggles(irToggles) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "IR Moves"));
        if (!irToggles.length) {
            card.appendChild(el("p", "placeholder", "No IR moves."));
            return card;
        }
        irToggles.forEach(function (req) {
            var row = el("div", "admin-line");
            row.appendChild(el("span", "admin-line-text",
                teamLabel(req.tid) + " — " + playerName(req.payload.pid) + " → " + (req.payload.to_ir ? "move to IR" : "move to active")));
            row.appendChild(badge(req.status));
            if (canApply(req)) {
                row.appendChild(button("Mark applied", "admin-btn admin-btn-small", function () { markApplied([req]); }));
            }
            card.appendChild(row);
        });
        return card;
    }

    // Only the commissioner can flag a player as IR-eligible; GMs then get
    // an IR checkbox next to that player on their roster page.
    function renderIrEligibility() {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "IR Eligibility"));
        var countNote = el("p", "admin-note");
        function updateCount() {
            var n = players.filter(function (p) { return p.ir_eligible; }).length;
            countNote.textContent = "Tick a player to let their GM move them to IR. " + n + " currently eligible (highlighted green).";
        }
        updateCount();
        card.appendChild(countNote);

        var details = el("details", "admin-details");
        details.appendChild(el("summary", "", "Show rosters"));
        teams.forEach(function (team) {
            var roster = players.filter(function (p) { return p.tid === team.tid; })
                .sort(function (a, b) { return (a.roster_order || 0) - (b.roster_order || 0); });
            if (!roster.length) return;
            var block = el("div", "admin-group");
            block.appendChild(el("div", "admin-group-title")).appendChild(el("strong", "", teamLabel(team.tid)));
            roster.forEach(function (p) {
                var label = el("label", "admin-check admin-ir-row" + (p.ir_eligible ? " is-eligible" : ""));
                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = !!p.ir_eligible;
                cb.addEventListener("change", async function () {
                    var result = await client.from("players_mirror").update({ ir_eligible: cb.checked }).eq("pid", p.pid);
                    if (result.error) {
                        console.error("Portal admin: IR flag failed", result.error);
                        cb.checked = !cb.checked;
                        toast("Couldn't save -- try again.", "error");
                        return;
                    }
                    p.ir_eligible = cb.checked;
                    label.classList.toggle("is-eligible", cb.checked);
                    updateCount();
                    toast(playerName(p.pid) + (cb.checked ? " is IR-eligible" : " is no longer IR-eligible") + " ✓", "ok");
                });
                label.appendChild(cb);
                label.appendChild(document.createTextNode(" " + playerName(p.pid)));
                label.appendChild(el("span", "admin-chip admin-chip-ir", "IR ELIGIBLE"));
                if (p.injury_status) label.appendChild(el("span", "admin-chip admin-chip-inj", "INJ \u00b7 " + p.injury_status));
                block.appendChild(label);
            });
            details.appendChild(block);
        });
        card.appendChild(details);
        return card;
    }

    render();
})();
