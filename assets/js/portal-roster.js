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
    fetch("../data/waiver_priority.json")
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

    var user = window.Portal.getUser();
    if (!user) return; // signed out -- every panel stays exactly as generated

    var client = window.Portal.getClient();

    var stateResult = await client.from("sync_state").select("current_week_number").eq("id", 1).single();
    var weekNumber = stateResult.data ? stateResult.data.current_week_number : null;
    if (!weekNumber) return; // no sync has run yet, nothing meaningful to show

    var myTeams = await window.Portal.getMyTeams();
    if (!myTeams.length) return; // signed in, but not a GM with teams here

    var myTidStrings = myTeams.map(function (t) { return String(t.tid); });

    var panels = Array.prototype.filter.call(
        document.querySelectorAll(".team-panel[data-tid]"),
        function (panel) { return myTidStrings.indexOf(panel.dataset.tid) !== -1; }
    );
    if (!panels.length) return;

    var STARTER_COUNT = 5; // BBGM's starting five; everyone after is bench

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

        var [playersResult, pendingResult] = await Promise.all([
            client.from("players_mirror").select("pid,ir_eligible").in("pid", pidsInPanel),
            client.from("gm_requests").select("id,type,tid,payload").eq("gm_id", user.id).eq("tid", tid).eq("week_number", weekNumber).eq("status", "pending"),
        ]);

        (pendingResult.data || []).forEach(function (req) {
            if (req.type === "add_drop") claim = req;
        });
        activePanels.push({ panel: panel, tid: tid });

        var irEligibleByPid = {};
        (playersResult.data || []).forEach(function (p) { irEligibleByPid[p.pid] = p.ir_eligible; });

        var ptByPid = {};
        var irByPid = {};
        var pendingOrderByPid = {};
        (pendingResult.data || []).forEach(function (req) {
            if (req.type === "pt_order_change") {
                if (req.payload.pt_level) ptByPid[req.payload.pid] = req.payload.pt_level;
                if (req.payload.roster_order !== undefined && req.payload.roster_order !== null) {
                    pendingOrderByPid[req.payload.pid] = req.payload.roster_order;
                }
            }
            if (req.type === "ir_toggle") irByPid[req.payload.pid] = req.payload.to_ir;
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
        lineupByTid[tid] = orderMap(tbodies[0]);

        Array.prototype.forEach.call(panel.querySelectorAll("tr[data-pid]"), function (row) {
            var pid = parseInt(row.dataset.pid, 10);

            var select = row.querySelector(".roster-pt-select");
            if (select) {
                if (ptByPid[pid]) select.value = ptByPid[pid];
                select.addEventListener("change", async function () {
                    var value = select.value;
                    forEachRowForPid(panel, pid, function (r) { r.querySelector(".roster-pt-select").value = value; });
                    await saveAndRefresh(panel, tid, function () {
                        return upsertPendingRequest(tid, "pt_order_change", pid, { pt_level: value });
                    });
                });
            }

            var irLabel = row.querySelector(".roster-ir-label");
            var irCheckbox = row.querySelector(".roster-ir-toggle");
            if (irLabel && irEligibleByPid[pid]) {
                irLabel.hidden = false;
                irCheckbox.checked = !!irByPid[pid];
                irCheckbox.addEventListener("change", async function () {
                    var checked = irCheckbox.checked;
                    forEachRowForPid(panel, pid, function (r) { r.querySelector(".roster-ir-toggle").checked = checked; });
                    await saveAndRefresh(panel, tid, function () {
                        return upsertPendingRequest(tid, "ir_toggle", pid, { to_ir: checked });
                    });
                });
            }

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

        if (addPid && "#" + panel.id === window.location.hash) startAdding(panel);
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
            banner.innerHTML = "<span>Adding <strong></strong> &mdash; tap <b>Drop</b> next to the player you want to release.</span>" +
                ' <button type="button" class="roster-adding-cancel">Cancel</button>';
            banner.querySelector("strong").textContent = addName;
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
            ", drop " + (req.payload.drop_name || "#" + req.payload.drop_pid);
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
        var dropPid = parseInt(row.dataset.pid, 10);
        var dropName = rowName(row);

        // One add/drop per GM per week (enforced by the database too), so a
        // new claim replaces any pending one -- say so before doing it.
        var existing = await client.from("gm_requests").select("id,tid,payload")
            .eq("gm_id", user.id).eq("type", "add_drop").eq("week_number", weekNumber).eq("status", "pending").maybeSingle();

        var message = "Add " + addName + " and drop " + dropName + "?";
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
            showToast(used ? "You've already used your add/drop for this week." : "Couldn't submit \u2014 check your connection and try again.", "error");
            return;
        }
        stopAdding(panel);
        renderClaims();
        showToast("Claim submitted \u2713", "ok");
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

        pickerEl.querySelector("h3").textContent = "Move Player";
        pickerEl.querySelector(".roster-picker-sub").textContent = isStarter
            ? "Pick a bench player to swap " + rowName(row) + " with, or keep them a starter."
            : "Pick a starter to swap " + rowName(row) + " with, or keep them on the bench.";

        var list = pickerEl.querySelector(".roster-picker-list");
        list.innerHTML = "";

        var current = document.createElement("div");
        current.className = "roster-picker-current";
        current.innerHTML = "<strong></strong><span></span>";
        current.querySelector("strong").textContent = rowName(row);
        current.querySelector("span").textContent = (isStarter ? "Starter" : "Bench") + " \u00b7 " + rowPos(row);
        list.appendChild(current);

        var heading = document.createElement("div");
        heading.className = "roster-picker-heading";
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
            btn.className = "roster-picker-option";
            btn.innerHTML = "<strong></strong><span></span>";
            btn.querySelector("strong").textContent = rowName(candidate);
            btn.querySelector("span").textContent = rowPos(candidate);
            btn.addEventListener("click", function () {
                swapPlayers(row, candidate, panel, tid, tbodies);
            });
            list.appendChild(btn);
        });

        pickerEl.hidden = false;
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
            return Promise.all(Object.keys(after).map(function (pid) {
                return upsertPendingRequest(tid, "pt_order_change", parseInt(pid, 10), { roster_order: after[pid] });
            }));
        });
        if (!ok) {
            lineupByTid[tid] = before;
            tbodies.forEach(function (tbody) { applyOrder(tbody, before); }); // put the rows back
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
            return el.tagName === "TR" && el.dataset.pid;
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
            tbody.appendChild(divider);
        }
    }
})();
