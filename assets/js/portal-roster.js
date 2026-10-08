// Makes the roster tables on a GM's own page (gms/*.html) actually
// interactive: a tap-to-swap starter/bench picker, a playing-time
// dropdown, and an IR toggle -- all hidden until we know who's signed in
// and which team(s) are theirs. Nothing here changes BBGM directly; every
// action writes a pending row to portal.gm_requests for the commissioner
// to review and apply by hand. Every change saves the moment it's made.
//
// Each team's roster actually appears in the DOM 3 times (the Last 7 /
// Last 14 / Full Season stat-window tabs are 3 separate <tbody>s with the
// same players, just different stat columns -- only one is visible at a
// time). Order, PT and IR changes have to keep all 3 copies in sync, or
// switching tabs would show a stale state.
(async function () {
    // Every team's waiver priority shows under its name for everyone, signed
    // in or not. It comes from a static file the weekly sync writes
    // (scripts/sync_portal.py), since the database only lets signed-in users
    // read it.
    fetch("../data/waiver_priority.json?t=" + Date.now())
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
            if (!data) return;
            Object.keys(data.priority).forEach(function (tid) {
                var panel = document.querySelector(".team-panel[data-tid='" + tid + "']");
                if (panel) renderWaiverPriority(panel, { priority_rank: data.priority[tid] });
            });
        })
        .catch(function () { /* no file yet -- the line just stays hidden */ });

    await window.Portal.ready;

    // Signing in or out changes which controls should exist (and undoes any
    // on-page reordering), so the simplest reliable thing is a fresh load.
    document.addEventListener("portal:auth-changed", function () {
        window.location.reload();
    });

    var PT_SHOWN = { "0": "0", "-": "\u2212", "normal": "\u2713", "+": "+", "++": "++" };
    var ROSTER_LIMIT = 12; // active players per team; IR spots are extra
    var IR_SPOTS = 2;
    var STARTER_COUNT = 5; // BBGM's starting five; everyone after is bench

    var user = window.Portal.getUser();
    var client = window.Portal.getClient();

    // Lineup order and playing time are saved the moment a GM changes them
    // and are public: everyone sees each team's real current choices, which
    // may be newer than the last BBGM export the page was built from.
    var lineupResult = await client.from("lineup_state").select("pid,tid,pt_level,roster_order");
    var lineupRows = lineupResult.data || [];
    var lineupPtByPid = {};
    var lineupOrderByTid = {};
    lineupRows.forEach(function (row) {
        if (row.pt_level) lineupPtByPid[row.pid] = row.pt_level;
        if (row.roster_order !== null && row.roster_order !== undefined) {
            (lineupOrderByTid[row.tid] = lineupOrderByTid[row.tid] || {})[row.pid] = row.roster_order;
        }
    });
    Array.prototype.forEach.call(document.querySelectorAll(".team-panel[data-tid]"), function (panel) {
        var order = lineupOrderByTid[panel.dataset.tid];
        Array.prototype.forEach.call(panel.querySelectorAll(".roster-table tbody"), function (tbody) {
            if (order) applyOrder(tbody, order);
        });
        Array.prototype.forEach.call(panel.querySelectorAll("tr[data-pid]"), function (row) {
            var level = lineupPtByPid[parseInt(row.dataset.pid, 10)];
            if (level) setPtBadge(row, level);
        });
    });

    // Players the commissioner has moved to IR (and marked applied) show on
    // IR for everyone.
    var irPublicResult = await client.from("ir_public").select("pid,tid");
    var irPublicByPid = {};
    (irPublicResult.data || []).forEach(function (row) { irPublicByPid[row.pid] = row.tid; });
    Array.prototype.forEach.call(document.querySelectorAll(".team-panel[data-tid]"), function (panel) {
        Array.prototype.forEach.call(panel.querySelectorAll(".roster-table tbody"), function (tbody) {
            Array.prototype.forEach.call(tbody.querySelectorAll("tr[data-pid]"), function (row) {
                var pid = parseInt(row.dataset.pid, 10);
                if (String(irPublicByPid[pid]) === panel.dataset.tid) setRowIr(tbody, pid, true);
            });
        });
    });

    // Players a GM has just dropped are off that roster for everyone straight away,
    // even before the commissioner releases them in BBGM (and a new export is built).
    var droppedResult = await client.from("dropped_public").select("pid,tid");
    (droppedResult.data || []).forEach(function (d) {
        var droppedPanel = document.querySelector(".team-panel[data-tid='" + d.tid + "']");
        if (droppedPanel) removePlayerRows(droppedPanel, d.pid);
    });

    if (!user) return; // signed out -- panels show the public view only

    var stateResult = await client.from("sync_state").select("current_week_number").eq("id", 1).single();
    var weekNumber = stateResult.data ? stateResult.data.current_week_number : null;
    if (!weekNumber) return; // no sync has run yet, nothing meaningful to show

    // The commissioner can manage every team's lineup, playing time and IR.
    var isCommissioner = !!user.is_commissioner;
    var myTeams = await window.Portal.getMyTeams();
    if (!myTeams.length && !isCommissioner) return; // signed in, but not a GM with teams here

    var myTidStrings = myTeams.map(function (t) { return String(t.tid); });

    var panels = Array.prototype.filter.call(
        document.querySelectorAll(".team-panel[data-tid]"),
        function (panel) { return isCommissioner || myTidStrings.indexOf(panel.dataset.tid) !== -1; }
    );
    if (!panels.length) return;

    // Handed over from the free agents page: ?add=<pid>&addname=<name>
    // plus #panel-<tid>. Puts that team's roster into "pick who to drop"
    // mode, which finishes the one-add/drop-per-week waiver claim.
    var urlParams = new URLSearchParams(window.location.search);
    var addPid = parseInt(urlParams.get("add"), 10) || null;
    var addName = urlParams.get("addname") || "Player #" + addPid;

    var activePanels = []; // {panel, tid} for each of the GM's own team panels
    var lineupByTid = {};  // tid -> {pid: slot index} -- the saved lineup, independent of any view sort
    var claim = null;      // this GM's pending add/drop for the week, if any

    for (var i = 0; i < panels.length; i++) {
        await activatePanel(panels[i], parseInt(panels[i].dataset.tid, 10));
    }
    renderClaims();

    async function activatePanel(panel, tid) {
        var pidsInPanel = Array.prototype.map.call(
            panel.querySelectorAll("tr[data-pid]"),
            function (row) { return parseInt(row.dataset.pid, 10); }
        );
        if (!pidsInPanel.length) return;

        var [playersResult, pendingResult, irResult] = await Promise.all([
            client.from("players_mirror").select("pid,ir_eligible").in("pid", pidsInPanel),
            client.from("gm_requests").select("id,type,tid,payload").eq("gm_id", user.id).eq("tid", tid).eq("week_number", weekNumber).eq("status", "pending"),
            client.from("gm_requests").select("payload,submitted_at").eq("gm_id", user.id).eq("tid", tid).eq("week_number", weekNumber)
                .eq("type", "ir_toggle").in("status", ["pending", "applied"]).order("submitted_at", { ascending: true }),
        ]);

        (pendingResult.data || []).forEach(function (req) {
            if (req.type === "add_drop") claim = req;
        });
        activePanels.push({ panel: panel, tid: tid });

        var irEligibleByPid = {};
        (playersResult.data || []).forEach(function (p) { irEligibleByPid[p.pid] = p.ir_eligible; });

        var ptByPid = lineupPtByPid;
        var irByPid = {};
        var pendingOrderByPid = lineupOrderByTid[tid] || {};
        // Latest IR choice wins, whether or not the commissioner has ticked it off.
        (irResult.data || []).forEach(function (req) {
            irByPid[req.payload.pid] = req.payload.to_ir;
        });

        // Re-sort every window-tab's table to match the last SAVED order
        // before anything is revealed, so a refresh shows what's stored.
        var tbodies = Array.prototype.slice.call(panel.querySelectorAll(".roster-table tbody"));
        if (Object.keys(pendingOrderByPid).length) {
            tbodies.forEach(function (tbody) { applyOrder(tbody, pendingOrderByPid); });
        }

        // The lineup as saved. A GM can also click a stats column header to
        // sort the table for viewing; that only changes what's on screen, so
        // swaps always work from this saved order instead of the DOM order.
        tbodies.forEach(function (tbody) {
            Object.keys(irByPid).forEach(function (pid) {
                // Latest choice wins: a pending "move back to active" beats the public IR list.
                var irRow = tbody.querySelector("tr[data-pid='" + pid + "']");
                if (irRow && irRow.classList.contains("is-ir") !== !!irByPid[pid]) setRowIr(tbody, parseInt(pid, 10), !!irByPid[pid]);
            });
            if (Object.keys(pendingOrderByPid).length) applyOrder(tbody, pendingOrderByPid);
        });
        lineupByTid[tid] = orderMap(tbodies[0]);

        Array.prototype.forEach.call(panel.querySelectorAll("tr[data-pid]"), function (row) {
            var pid = parseInt(row.dataset.pid, 10);

            var select = row.querySelector(".roster-pt-select");
            if (select) {
                var shownCell = row.querySelector(".roster-pt-view");
                var shownLevel = shownCell && shownCell.dataset.pt ? shownCell.dataset.pt : "normal";
                select.value = ptByPid[pid] || shownLevel;
                select.addEventListener("change", async function () {
                    var value = select.value;
                    forEachRowForPid(panel, pid, function (r) { r.querySelector(".roster-pt-select").value = value; setPtBadge(r, value); });
                    await saveAndRefresh(panel, tid, function () {
                        return saveLineup(tid, pid, { pt_level: value });
                    });
                });
            }

            // IR is handled from the Move dialog: eligible players get an "Injured Reserve"
            // choice there (and players already on IR get "Move back to the roster").
            if (irEligibleByPid[pid] || isCommissioner) row.dataset.irEligible = "1";
            row.dataset.tid = String(tid);

            var dropBtn = row.querySelector(".roster-drop-btn");
            if (dropBtn) {
                dropBtn.addEventListener("click", function () {
                    if (panel.classList.contains("is-adding")) submitClaim(panel, tid, row);
                });
            }

            var moveBtn = row.querySelector(".roster-move-btn");
            if (moveBtn) {
                moveBtn.addEventListener("click", function () {
                    openPicker(row, panel, tid, tbodies);
                });
            }
        });

        // Reveals the move/PT columns (they're display:none until now).
        panel.classList.add("is-managing");

        if (addPid && "#" + panel.id === (window.linkedPanelHash || window.location.hash)) startAdding(panel);
    }

    function activeCount(panel) {
        var tbody = panel.querySelector(".roster-table tbody");
        return tbody ? getManagedRows(tbody).length : 0;
    }

    function irCount(panel) {
        var tbody = panel.querySelector(".roster-table tbody");
        return tbody ? tbody.querySelectorAll("tr.is-ir[data-pid]").length : 0;
    }

    function forEachRowForPid(panel, pid, fn) {
        Array.prototype.forEach.call(panel.querySelectorAll("tr[data-pid='" + pid + "']"), fn);
    }

    // Runs a save, then shows "Saved" or an error toast. Returns true on success.
    async function saveAndRefresh(panel, tid, saveFn) {
        showToast("Saving…", "");
        try {
            await saveFn();
            showToast("Saved ✓", "ok");
            return true;
        } catch (err) {
            console.error("Portal: save failed", err);
            showToast("Couldn't save — check your connection and try again.", "error");
            return false;
        }
    }

    var toastEl = null;
    var toastTimer = null;
    function showToast(text, kind) {
        if (!toastEl) {
            toastEl = document.createElement("div");
            toastEl.className = "portal-toast";
            toastEl.setAttribute("role", "status");
            toastEl.setAttribute("aria-live", "polite");
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.className = "portal-toast is-visible" + (kind ? " is-" + kind : "");
        clearTimeout(toastTimer);
        if (kind) {
            toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, kind === "error" ? 5000 : 1800);
        }
    }

    // ---- Add/drop waiver claim -----------------------------------------

    function startAdding(panel) {
        panel.classList.add("is-adding");
        Array.prototype.forEach.call(panel.querySelectorAll(".roster-adding-banner"), function (banner) {
            var open = activeCount(panel) < ROSTER_LIMIT;   // e.g. someone is on IR
            banner.innerHTML = "<span>Adding <strong></strong> &mdash; " +
                (open
                    ? "you have an open roster spot, so you can add without dropping anyone, or tap the <b>&minus;</b> next to a player to release."
                    : "tap the <b>&minus;</b> next to the player you want to release.") +
                "</span>" +
                (open ? ' <button type="button" class="roster-adding-nodrop">Add without dropping</button>' : "") +
                ' <button type="button" class="roster-adding-cancel">Cancel</button>';
            banner.querySelector("strong").textContent = addName;
            var noDrop = banner.querySelector(".roster-adding-nodrop");
            if (noDrop) noDrop.addEventListener("click", function () { submitClaim(panel, parseInt(panel.dataset.tid, 10), null); });
            banner.querySelector(".roster-adding-cancel").addEventListener("click", function () { stopAdding(panel); });
            banner.hidden = false;
        });
    }

    function stopAdding(panel) {
        panel.classList.remove("is-adding");
        Array.prototype.forEach.call(panel.querySelectorAll(".roster-adding-banner"), function (banner) {
            banner.hidden = true;
        });
        history.replaceState(null, "", window.location.pathname + window.location.hash);
        addPid = null;
    }

    function claimText(req) {
        return "add " + (req.payload.add_name || "#" + req.payload.add_pid) +
            (req.payload.drop_pid ? ", drop " + (req.payload.drop_name || "#" + req.payload.drop_pid) : " (no drop)");
    }

    // The claim is shown on the team it belongs to, with a way to withdraw it.
    function renderClaims() {
        activePanels.forEach(function (entry) {
            var el = entry.panel.querySelector(".roster-claim");
            if (!el) return;
            if (!claim || claim.tid !== entry.tid) {
                el.hidden = true;
                el.textContent = "";
                return;
            }
            el.textContent = "";
            var label = document.createElement("strong");
            label.textContent = "Waiver claim: ";
            var text = document.createElement("span");
            text.textContent = claimText(claim) + " ";
            var cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "roster-claim-cancel";
            cancel.textContent = "Cancel claim";
            cancel.addEventListener("click", cancelClaim);
            el.appendChild(label);
            el.appendChild(text);
            el.appendChild(cancel);
            el.hidden = false;
        });
    }

    async function cancelClaim() {
        if (!claim) return;
        var ok = await confirmDialog("Cancel waiver claim?", "Withdraw your claim to " + claimText(claim) + "?", "Cancel claim", "Keep it");
        if (!ok) return;
        showToast("Saving\u2026", "");
        var result = await client.from("gm_requests").delete().eq("id", claim.id);
        if (result.error) {
            showToast("Couldn't cancel \u2014 try again.", "error");
            return;
        }
        claim = null;
        renderClaims();
        showToast("Claim cancelled \u2713", "ok");
    }

    async function submitClaim(panel, tid, row) {
        var dropPid = row ? parseInt(row.dataset.pid, 10) : null;   // null: adding into an open roster spot
        var dropName = row ? rowName(row) : null;

        // One add/drop per GM per week (enforced by the database too), so a
        // new claim replaces any pending one -- say so before doing it.
        var existing = await client.from("gm_requests").select("id,tid,payload")
            .eq("gm_id", user.id).eq("type", "add_drop").eq("week_number", weekNumber).eq("status", "pending").maybeSingle();

        var message = dropPid ? "Add " + addName + " and drop " + dropName + "?"
                              : "Add " + addName + " without dropping anyone? (You have an open roster spot.)";
        if (existing.data) {
            message += " You can only make one add/drop per week, so this replaces your current claim (" + claimText(existing.data) + ").";
        }
        var ok = await confirmDialog("Confirm waiver claim", message, "Submit claim", "Go back");
        if (!ok) return;

        showToast("Saving\u2026", "");
        try {
            if (existing.data) {
                var removed = await client.from("gm_requests").delete().eq("id", existing.data.id);
                if (removed.error) throw removed.error;
            }
            var payload = { add_pid: addPid, add_name: addName, drop_pid: dropPid, drop_name: dropName };
            var inserted = await client.from("gm_requests")
                .insert({ gm_id: user.id, tid: tid, type: "add_drop", week_number: weekNumber, payload: payload })
                .select("id,type,tid,payload").single();
            if (inserted.error) throw inserted.error;
            claim = inserted.data;
        } catch (err) {
            console.error("Portal: claim failed", err);
            // 23505 = the one-add/drop-per-week unique index (e.g. an earlier claim was already resolved)
            var used = err && err.code === "23505";
            var reclaim = err && /dropped this player/i.test(err.message || "");   // blocked by the database trigger
            showToast(used ? "You've already used your add/drop for this week."
                : reclaim ? "You dropped " + addName + " this week, so you can't claim him back until next week."
                : "Couldn't submit \u2014 check your connection and try again.", "error");
            return;
        }
        stopAdding(panel);
        renderClaims();
        showToast("Claim submitted \u2713", "ok");
    }

    function removePlayerRows(panel, pid) {
        Array.prototype.forEach.call(panel.querySelectorAll(".roster-table tbody"), function (tbody) {
            var row = tbody.querySelector("tr[data-pid='" + pid + "']");
            if (row) row.remove();
            layoutIrSection(tbody);   // re-places the Bench / IR dividers
        });
    }

    // Standalone drop: the player leaves this roster and joins the free agent list at
    // once. It is not an add/drop, so it doesn't touch the one-per-week limit. The
    // commissioner then releases him in BBGM (portal.dropped_public feeds the admin page).
    async function dropPlayer(row, panel, tid, tbodies) {
        if (pickerBusy) return;
        var pid = parseInt(row.dataset.pid, 10);
        var name = rowName(row);
        closePicker();
        if (claim && claim.tid === tid && claim.payload.drop_pid === pid) {
            showToast("Cancel your waiver claim first \u2014 it drops " + name + ".", "error");
            return;
        }
        var ok = await confirmDialog(
            "Drop " + name + "?",
            name + " leaves your roster now and goes to the Free Agents list, where anyone except you can claim him this week. " +
            "This doesn't use your weekly add/drop, and it can't be undone.",
            "Drop " + name, "Keep him"
        );
        if (!ok) return;
        pickerBusy = true;
        showToast("Saving\u2026", "");
        try {
            var inserted = await client.from("dropped_public").insert({
                pid: pid, tid: tid, dropped_by: user.id, player_name: name, week_number: weekNumber,
            });
            if (inserted.error) throw inserted.error;
            // A pending "move to IR" request for him no longer means anything.
            await client.from("gm_requests").delete()
                .eq("gm_id", user.id).eq("type", "ir_toggle").eq("week_number", weekNumber).eq("status", "pending")
                .filter("payload->>pid", "eq", String(pid));
            removePlayerRows(panel, pid);
            lineupByTid[tid] = orderMap(tbodies[0]);
            showToast(name + " dropped \u2713", "ok");
        } catch (err) {
            console.error("Portal: drop failed", err);
            showToast(err && err.code === "23505"
                ? "That player is already dropped."
                : "Couldn't drop \u2014 check your connection and try again.", "error");
        }
        pickerBusy = false;
    }

    function addDropOption(list, row, panel, tid, tbodies) {
        var heading = document.createElement("div");
        heading.className = "roster-picker-heading";
        heading.textContent = "Or";
        list.appendChild(heading);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "roster-picker-option roster-picker-release";
        btn.innerHTML = "<strong>Drop this player</strong><span></span>";
        btn.querySelector("span").textContent = "Release " + rowName(row) + " to free agency (doesn't use your add/drop)";
        btn.addEventListener("click", function () { dropPlayer(row, panel, tid, tbodies); });
        list.appendChild(btn);
    }

    function confirmDialog(title, message, yesLabel, noLabel) {
        return new Promise(function (resolve) {
            var el = document.createElement("div");
            el.className = "roster-picker-backdrop";
            el.innerHTML =
                '<div class="roster-picker" role="dialog" aria-modal="true">' +
                '<div class="roster-picker-header"><div><h3></h3><p class="roster-picker-sub"></p></div></div>' +
                '<div class="roster-confirm-actions">' +
                '<button type="button" class="roster-confirm-no"></button>' +
                '<button type="button" class="roster-confirm-yes"></button>' +
                "</div></div>";
            el.querySelector("h3").textContent = title;
            el.querySelector(".roster-picker-sub").textContent = message;
            el.querySelector(".roster-confirm-yes").textContent = yesLabel;
            el.querySelector(".roster-confirm-no").textContent = noLabel || "Cancel";
            function done(value) {
                el.remove();
                resolve(value);
            }
            el.querySelector(".roster-confirm-yes").addEventListener("click", function () { done(true); });
            el.querySelector(".roster-confirm-no").addEventListener("click", function () { done(false); });
            el.addEventListener("click", function (e) { if (e.target === el) done(false); });
            document.body.appendChild(el);
        });
    }

    // ---- Starter/bench swap picker -------------------------------------

    var pickerEl = null;
    var pickerBusy = false;

    function buildPicker() {
        pickerEl = document.createElement("div");
        pickerEl.className = "roster-picker-backdrop";
        pickerEl.hidden = true;
        pickerEl.innerHTML =
            '<div class="roster-picker" role="dialog" aria-modal="true" aria-labelledby="roster-picker-title">' +
            '<div class="roster-picker-header">' +
            '<div><h3 id="roster-picker-title"></h3><p class="roster-picker-sub"></p></div>' +
            '<button type="button" class="roster-picker-close" aria-label="Close">&times;</button>' +
            "</div>" +
            '<div class="roster-picker-list"></div>' +
            "</div>";
        document.body.appendChild(pickerEl);
        pickerEl.addEventListener("click", function (e) {
            if (e.target === pickerEl || e.target.closest(".roster-picker-close")) closePicker();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && !pickerEl.hidden) closePicker();
        });
    }

    function closePicker() {
        if (pickerEl) pickerEl.hidden = true;
    }

    function rowName(row) {
        var link = row.querySelector("a");
        return link ? (link.getAttribute("title") || link.textContent) : "Player";
    }

    function rowPos(row) {
        // cells: [move][pos][name][pt]...
        return row.cells[1] ? row.cells[1].textContent : "";
    }

    function openPicker(row, panel, tid, tbodies) {
        if (!pickerEl) buildPicker();
        var lineup = lineupByTid[tid];
        var pid = parseInt(row.dataset.pid, 10);
        var isStarter = lineup[pid] < STARTER_COUNT;

        // Everyone on the other side of the starter/bench line, in lineup order.
        var candidates = Object.keys(lineup)
            .filter(function (otherPid) { return (lineup[otherPid] < STARTER_COUNT) !== isStarter; })
            .sort(function (a, b) { return lineup[a] - lineup[b]; })
            .map(function (otherPid) { return row.parentElement.querySelector("tr[data-pid='" + otherPid + "']"); })
            .filter(Boolean);

        var onIr = row.classList.contains("is-ir");
        var canIr = !onIr && row.dataset.irEligible === "1";
        var irFull = canIr && irCount(panel) >= IR_SPOTS;

        if (onIr) {
            openIrActivatePicker(row, panel, tid, tbodies);
            return;
        }

        pickerEl.querySelector("h3").textContent = "Move Player";
        pickerEl.querySelector(".roster-picker-sub").textContent = isStarter
            ? "Pick a bench player to swap " + rowName(row) + " with, or keep them a starter."
            : "Swap " + rowName(row) + " with a starter, or move them within the bench.";

        var list = pickerEl.querySelector(".roster-picker-list");
        list.innerHTML = "";

        var current = document.createElement("div");
        current.className = "roster-picker-current";
        current.innerHTML = "<strong></strong><span></span>";
        current.querySelector("strong").textContent = rowName(row);
        current.querySelector("span").textContent = (isStarter ? "Starter" : "Bench") + " \u00b7 " + rowPos(row);
        list.appendChild(current);

        var heading = document.createElement("div");
        heading.className = "roster-picker-heading roster-picker-heading-bench";
        heading.textContent = isStarter ? "Swap with (bench)" : "Swap with (starters)";
        list.appendChild(heading);

        if (!candidates.length) {
            var none = document.createElement("p");
            none.className = "roster-picker-empty";
            none.textContent = isStarter ? "No one on the bench yet." : "No starters to swap with.";
            list.appendChild(none);
        }

        candidates.forEach(function (candidate) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "roster-picker-option" + (isStarter ? " is-bench" : " is-starter");
            btn.innerHTML = "<strong></strong><span></span>";
            btn.querySelector("strong").textContent = rowName(candidate);
            btn.querySelector("span").textContent = rowPos(candidate);
            btn.addEventListener("click", function () {
                swapPlayers(row, candidate, panel, tid, tbodies);
            });
            list.appendChild(btn);
        });

        // Bench players can also be put into any other bench spot: the player takes
        // that spot and everyone in between shifts down (or up) one.
        if (!isStarter) {
            var benchPids = Object.keys(lineup)
                .filter(function (otherPid) { return lineup[otherPid] >= STARTER_COUNT; })
                .sort(function (a, b) { return lineup[a] - lineup[b]; });
            var benchHeading = document.createElement("div");
            benchHeading.className = "roster-picker-heading roster-picker-heading-bench";
            benchHeading.textContent = "Move to bench spot";
            list.appendChild(benchHeading);
            benchPids.forEach(function (otherPid, spot) {
                var isSelf = String(pid) === otherPid;
                var occupant = row.parentElement.querySelector("tr[data-pid='" + otherPid + "']");
                if (!occupant) return;
                var mbtn = document.createElement("button");
                mbtn.type = "button";
                mbtn.className = "roster-picker-option is-bench";
                mbtn.innerHTML = "<strong></strong><span></span>";
                mbtn.querySelector("strong").textContent = "Spot " + (spot + 1) + " \u00b7 " + rowName(occupant) + (isSelf ? " (current)" : "");
                if (spot === 0) {
                    var firstNote = document.createElement("small");
                    firstNote.className = "roster-picker-spot-note";
                    firstNote.textContent = "First off the bench";
                    mbtn.querySelector("strong").appendChild(firstNote);
                }
                mbtn.querySelector("span").textContent = rowPos(occupant);
                if (isSelf) {
                    mbtn.disabled = true;
                } else {
                    mbtn.addEventListener("click", function () {
                        moveToSpot(row, lineup[otherPid], panel, tid, tbodies);
                    });
                }
                list.appendChild(mbtn);
            });
        }

        if (canIr) {
            var irHeading = document.createElement("div");
            irHeading.className = "roster-picker-heading";
            irHeading.textContent = "Or";
            list.appendChild(irHeading);
            var irBtn = document.createElement("button");
            irBtn.type = "button";
            irBtn.className = "roster-picker-option roster-picker-ir";
            irBtn.innerHTML = "<strong>Injured Reserve</strong><span></span>";
            irBtn.querySelector("span").textContent = irFull
                ? "Both IR spots are full"
                : "Take " + rowName(row) + " off the active roster";
            irBtn.disabled = irFull;
            irBtn.addEventListener("click", function () {
                if (!irFull) setIr(row, panel, tid, tbodies, true);
            });
            list.appendChild(irBtn);
            list.appendChild(irNote("BBGM has no IR slot, so while a player is on IR the commissioner sets his playing time to 0 there. It goes back to normal when he returns."));
        }

        addDropOption(list, row, panel, tid, tbodies);

        pickerEl.hidden = false;
    }

    // Move dialog for a player who is on IR: the only move is back to the active roster.
    function openIrActivatePicker(row, panel, tid, tbodies) {
        pickerEl.querySelector("h3").textContent = "Injured Reserve";
        pickerEl.querySelector(".roster-picker-sub").textContent =
            rowName(row) + " is on IR. Move them back to the active roster (the end of the bench), or leave them on IR.";
        var list = pickerEl.querySelector(".roster-picker-list");
        list.innerHTML = "";
        var current = document.createElement("div");
        current.className = "roster-picker-current";
        current.innerHTML = "<strong></strong><span></span>";
        current.querySelector("strong").textContent = rowName(row);
        current.querySelector("span").textContent = "Injured Reserve \u00b7 " + rowPos(row);
        list.appendChild(current);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "roster-picker-option";
        btn.innerHTML = "<strong>Move back to active roster</strong><span></span>";
        var full = activeCount(panel) >= ROSTER_LIMIT;
        btn.querySelector("span").textContent = full
            ? "Roster is full (" + ROSTER_LIMIT + ") \u2014 drop a player first"
            : "Joins the bench";
        btn.disabled = full;
        btn.addEventListener("click", function () {
            if (!full) setIr(row, panel, tid, tbodies, false);
        });
        list.appendChild(btn);
        if (full) list.appendChild(irNote("Roster full? Drop someone first (open their Move menu and choose Drop this player), then come back here."));
        addDropOption(list, row, panel, tid, tbodies);
        list.appendChild(irNote("His playing time goes back to normal (or whatever you set) once the commissioner enters the move in BBGM."));
        pickerEl.hidden = false;
    }

    function irNote(text) {
        var note = document.createElement("p");
        note.className = "roster-picker-note";
        note.textContent = text;
        return note;
    }

    async function setIr(row, panel, tid, tbodies, toIr) {
        if (pickerBusy) return;
        pickerBusy = true;
        closePicker();
        var pid = parseInt(row.dataset.pid, 10);
        var before = lineupByTid[tid];
        tbodies.forEach(function (tbody) { setRowIr(tbody, pid, toIr); });
        lineupByTid[tid] = orderMap(tbodies[0]);
        var ok = await saveAndRefresh(panel, tid, function () {
            // The commissioner's IR changes go live at once (no request to approve).
            return isCommissioner ? saveIrAsCommissioner(tid, pid, toIr) : upsertPendingRequest(tid, "ir_toggle", pid, { to_ir: toIr });
        });
        if (!ok) {   // put it back the way it was
            tbodies.forEach(function (tbody) { setRowIr(tbody, pid, !toIr); });
            lineupByTid[tid] = before;
        }
        pickerBusy = false;
    }

    async function swapPlayers(rowA, rowB, panel, tid, tbodies) {
        if (pickerBusy) return;
        pickerBusy = true;
        closePicker();

        var before = lineupByTid[tid];
        var pidA = parseInt(rowA.dataset.pid, 10);
        var pidB = parseInt(rowB.dataset.pid, 10);
        var after = Object.assign({}, before);
        after[pidA] = before[pidB];
        after[pidB] = before[pidA];
        lineupByTid[tid] = after;
        tbodies.forEach(function (tbody) { applyOrder(tbody, after); });

        // Every player's slot is written, not just the two swapped, so the
        // saved order is always complete and consistent.
        var ok = await saveAndRefresh(panel, tid, function () {
            return saveLineupOrder(tid, after);
        });
        if (!ok) {
            lineupByTid[tid] = before;
            tbodies.forEach(function (tbody) { applyOrder(tbody, before); }); // put the rows back
        }
        pickerBusy = false;
    }

    // Puts a player into a given slot of the lineup, shifting everyone in between by one.
    async function moveToSpot(row, slot, panel, tid, tbodies) {
        if (pickerBusy) return;
        pickerBusy = true;
        closePicker();

        var before = lineupByTid[tid];
        var pid = parseInt(row.dataset.pid, 10);
        var pids = Object.keys(before).map(Number).sort(function (a, b) { return before[a] - before[b]; });
        pids.splice(pids.indexOf(pid), 1);
        pids.splice(slot, 0, pid);
        var after = {};
        pids.forEach(function (p, i) { after[p] = i; });
        lineupByTid[tid] = after;
        tbodies.forEach(function (tbody) { applyOrder(tbody, after); });

        var ok = await saveAndRefresh(panel, tid, function () {
            return saveLineupOrder(tid, after);
        });
        if (!ok) {
            lineupByTid[tid] = before;
            tbodies.forEach(function (tbody) { applyOrder(tbody, before); });
        }
        pickerBusy = false;
    }

    function orderMap(tbody) {
        var map = {};
        getManagedRows(tbody).forEach(function (r, i) { map[parseInt(r.dataset.pid, 10)] = i; });
        return map;
    }

    // ---- Display helpers ------------------------------------------------

    function renderWaiverPriority(panel, priorityRow) {
        var el = panel.querySelector(".roster-waiver-priority");
        if (!el || !priorityRow) return;
        el.textContent = "Waiver priority: #" + priorityRow.priority_rank + " of 8";
        el.hidden = false;
    }

    // Lineup/PT rows are one per player, saved straight away (no approval).
    async function saveLineup(tid, pid, patch) {
        var result = await client.from("lineup_state").upsert(
            Object.assign({ pid: pid, tid: tid, updated_by: user.id, updated_at: new Date().toISOString() }, patch),
            { onConflict: "pid" }
        );
        if (result.error) throw result.error;
    }

    // Writes the public IR list directly, and cancels any GM request for the
    // same player that says the opposite so it can't override this.
    async function saveIrAsCommissioner(tid, pid, toIr) {
        var result = toIr
            ? await client.from("ir_public").upsert({ pid: pid, tid: tid, updated_at: new Date().toISOString() }, { onConflict: "pid" })
            : await client.from("ir_public").delete().eq("pid", pid);
        if (result.error) throw result.error;
        var cancel = await client.from("gm_requests").update({ status: "cancelled" })
            .eq("type", "ir_toggle").eq("week_number", weekNumber).neq("status", "cancelled")
            .filter("payload->>pid", "eq", String(pid))
            .filter("payload->>to_ir", "eq", String(!toIr));
        if (cancel.error) throw cancel.error;
    }

    async function saveLineupOrder(tid, orderByPid) {
        var stamp = new Date().toISOString();
        var rows = Object.keys(orderByPid).map(function (pid) {
            return { pid: parseInt(pid, 10), tid: tid, roster_order: orderByPid[pid], updated_by: user.id, updated_at: stamp };
        });
        var result = await client.from("lineup_state").upsert(rows, { onConflict: "pid" });
        if (result.error) throw result.error;
    }

    // Read-only playing-time column cell for everyone not managing this team.
    function setPtBadge(row, level) {
        var cell = row.querySelector(".roster-pt-view");
        if (!cell) return;
        cell.dataset.pt = level;
        cell.textContent = PT_SHOWN[level] || level;
    }

    // Finds (or creates) this week's pending row for this exact
    // (gm, pid, type) and merges the new fields into its payload, so
    // repeated changes to the same player update one row instead of
    // piling up duplicates. Throws if Supabase reports an error.
    async function upsertPendingRequest(tid, type, pid, patch) {
        var existing = await client
            .from("gm_requests")
            .select("id,payload")
            .eq("gm_id", user.id)
            .eq("type", type)
            .eq("week_number", weekNumber)
            .eq("status", "pending")
            .filter("payload->>pid", "eq", String(pid))
            .maybeSingle();
        if (existing.error) throw existing.error;

        var result;
        if (existing.data) {
            var merged = Object.assign({}, existing.data.payload, patch);
            result = await client.from("gm_requests").update({ payload: merged }).eq("id", existing.data.id);
        } else {
            result = await client.from("gm_requests").insert({
                gm_id: user.id, tid: tid, type: type, week_number: weekNumber,
                payload: Object.assign({ pid: pid }, patch),
            });
        }
        if (result.error) throw result.error;
    }

    function getManagedRows(tbody) {
        return Array.prototype.filter.call(tbody.children, function (el) {
            return el.tagName === "TR" && el.dataset.pid && !el.classList.contains("is-ir");
        });
    }

    // Sorts a tbody's rows to match orderByPid, putting any pid missing
    // from it at the end in its existing relative order.
    function applyOrder(tbody, orderByPid) {
        var rows = getManagedRows(tbody);
        var withIndex = rows.map(function (row, i) { return { row: row, i: i }; });
        withIndex.sort(function (a, b) {
            var av = orderByPid[parseInt(a.row.dataset.pid, 10)];
            var bv = orderByPid[parseInt(b.row.dataset.pid, 10)];
            if (av === undefined && bv === undefined) return a.i - b.i;
            if (av === undefined) return 1;
            if (bv === undefined) return -1;
            return av - bv;
        });
        withIndex.forEach(function (entry) { tbody.appendChild(entry.row); });
        layoutIrSection(tbody);   // also re-places the Bench divider
    }

    // ---- Injured reserve: IR players drop to the bottom, under their own divider ----

    function setRowIr(tbody, pid, onIr) {
        var row = tbody.querySelector("tr[data-pid='" + pid + "']");
        if (!row) return;
        row.classList.toggle("is-ir", onIr);
        var nameCell = row.querySelector(".col-player");
        var badge = row.querySelector(".ir-badge");
        if (onIr && !badge && nameCell) {
            badge = document.createElement("span");
            badge.className = "ir-badge";
            badge.textContent = "IR";
            badge.title = "On injured reserve";
            nameCell.appendChild(badge);
        }
        if (!onIr) {
            if (badge) badge.remove();
            // back to the bottom of the active players (end of the bench)
            var divider = tbody.querySelector(".ir-divider");
            if (divider) tbody.insertBefore(row, divider); else tbody.appendChild(row);
        }
        layoutIrSection(tbody);
    }

    function layoutIrSection(tbody) {
        var irRows = Array.prototype.filter.call(tbody.children, function (el) {
            return el.tagName === "TR" && el.dataset.pid && el.classList.contains("is-ir");
        });
        var divider = tbody.querySelector(".ir-divider");
        if (!irRows.length) {
            if (divider) divider.remove();
            repositionDivider(tbody);
            return;
        }
        if (!divider) {
            divider = document.createElement("tr");
            divider.className = "ir-divider";
            var cell = document.createElement("td");
            cell.colSpan = tbody.parentElement.querySelectorAll("thead th").length;
            var label = document.createElement("span");
            label.textContent = "Injured Reserve";
            cell.appendChild(label);
            divider.appendChild(cell);
        }
        tbody.appendChild(divider);
        irRows.forEach(function (row) { tbody.appendChild(row); });
        repositionDivider(tbody);
    }

    function repositionDivider(tbody) {
        var divider = tbody.querySelector(".bench-divider");
        if (!divider) return;
        var rows = getManagedRows(tbody);
        var firstBench = rows[STARTER_COUNT];
        if (firstBench) {
            tbody.insertBefore(divider, firstBench);
        } else {
            tbody.insertBefore(divider, tbody.querySelector(".ir-divider"));
        }
    }
})();
