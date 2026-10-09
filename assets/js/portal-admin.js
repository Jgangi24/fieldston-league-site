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
            client.from("gm_requests").select("id,gm_id,tid,type,status,payload,submitted_at,week_number").gte("week_number", Math.max(currentWeek - 1, 0)).order("submitted_at"),
            client.from("waiver_priority").select("tid,priority_rank").eq("week_number", currentWeek),
            client.from("lineup_state").select("pid,tid,pt_level,roster_order"),
            client.from("ir_public").select("pid,tid"),
            client.from("dropped_public").select("pid,tid,dropped_by,player_name,week_number,dropped_at").order("dropped_at"),
        ]);
        if (results[0].error || results[1].error || results[2].error || results[3].error) {
            console.error("Portal admin: load failed", results);
            return showMessage("Couldn't load this week's requests -- check your connection and refresh.");
        }

        var allRequests = results[0].data.filter(function (r) { return r.status !== "cancelled"; });
        irRequests = allRequests.filter(function (r) { return r.type === "ir_toggle"; });
        lineupRows = results[2].data;
        // Who is on IR: the public list (GMs' moves are public at once), overridden by
        // this week's latest IR request per player in case a public write didn't go through.
        irByPid = {};
        results[3].data.forEach(function (r) { irByPid[r.pid] = true; });
        irRequests.filter(function (r) { return r.week_number === currentWeek; })
            .forEach(function (r) { irByPid[r.payload.pid] = !!r.payload.to_ir; });
        var rankByTid = {};
        results[1].data.forEach(function (w) { rankByTid[w.tid] = w.priority_rank; });

        // Drops still waiting on the commissioner: the latest BBGM export still has the player on that team.
        var pendingDrops = (results[4].error ? [] : results[4].data).filter(function (d) {
            var p = playerByPid[d.pid];
            return p && p.tid === d.tid;
        });
        if (results[4].error) console.error("Portal admin: couldn't load drops (is SQL 021 run?)", results[4].error);

        // A claim is finished once the last BBGM export has the player on the claiming team.
        var claims = allRequests.filter(function (r) { return r.type === "add_drop"; });
        var openClaims = claims.filter(function (c) {
            var p = playerByPid[c.payload.add_pid];
            return !(p && p.tid === c.tid);
        });

        root.innerHTML = "";
        root.appendChild(el("h1", "", "Commissioner Dashboard"));
        root.appendChild(renderStepOne(openClaims, rankByTid));
        root.appendChild(renderDrops(pendingDrops));
        root.appendChild(renderClaimsToEnter(openClaims, rankByTid));
        root.appendChild(renderLineups());
        root.appendChild(renderOnIr());
        root.appendChild(renderIrEligibility());
        root.appendChild(renderAllRequests(allRequests));
    }

    // Week 14 is the last regular-season week and runs past a normal 7 days, so it
    // is played with BBGM's "Until playoffs" instead of "One week". Remind the
    // commissioner from the week before.
    function seasonReminder() {
        if (currentWeek === 13) {
            return "Heads up: after this week, Week 14 is the last week of the season. Sim it with Play → Until playoffs (not One week).";
        }
        if (currentWeek === 14) {
            return "Next sim is Week 14, the last regular-season week: in BBGM choose Play → Until playoffs (not One week).";
        }
        if (currentWeek >= 15) {
            return "The regular season is complete. Playoffs are next.";
        }
        return null;
    }

    // Everything on this page is a to-do for BBGM. Items clear themselves after your next
    // export shows them done, so there is nothing to tick off. The one button is Resolve
    // Waivers, so claims are settled before you sim.
    function renderStepOne(openClaims, rankByTid) {
        var card = el("div", "card admin-toolbar");
        var reminder = seasonReminder();
        if (reminder) card.appendChild(el("p", "admin-reminder", reminder));
        card.appendChild(el("h3", "", "Week " + currentWeek + " — before you sim"));
        card.appendChild(el("p", "admin-note", "Work down this page: 1 resolve waivers, 2 release dropped players, 3 enter the winning claims, 4 set IR, playing time and lineups. Items disappear by themselves after your next export."));

        var order = Object.keys(rankByTid).sort(function (a, b) { return rankByTid[a] - rankByTid[b]; });
        if (order.length) {
            card.appendChild(el("p", "admin-note", "Waiver order: " + order.map(function (tid, i) {
                return (i + 1) + ". " + teamLabel(parseInt(tid, 10));
            }).join("  ·  ")));
        }

        var pending = openClaims.filter(function (c) { return c.status === "pending"; });
        card.appendChild(el("h4", "admin-subhead", "1. Resolve waivers"));
        if (!pending.length) {
            card.appendChild(el("p", "placeholder", openClaims.length ? "All claims are resolved." : "No claims waiting."));
            return card;
        }

        // Preview: per player, who would win by waiver priority.
        var groups = {};
        pending.forEach(function (c) { (groups[c.payload.add_pid] = groups[c.payload.add_pid] || []).push(c); });
        Object.keys(groups).forEach(function (pid) {
            var list = groups[pid].slice().sort(function (a, b) { return (rankByTid[a.tid] || 99) - (rankByTid[b.tid] || 99); });
            var group = el("div", "admin-group" + (list.length > 1 ? " admin-contested" : ""));
            var title = el("div", "admin-group-title");
            title.appendChild(el("strong", "", "Add " + playerName(parseInt(pid, 10))));
            if (list.length > 1) title.appendChild(el("span", "admin-badge admin-badge-contested", list.length + " teams want him"));
            group.appendChild(title);
            list.forEach(function (c, i) {
                var row = el("div", "admin-line");
                row.appendChild(el("span", "admin-line-text", teamLabel(c.tid) + " — " + claimDropText(c) +
                    (rankByTid[c.tid] ? " — priority #" + rankByTid[c.tid] : "")));
                row.appendChild(el("span", "admin-badge admin-badge-" + (i === 0 ? "won" : "lost"), i === 0 ? "wins" : "loses"));
                group.appendChild(row);
            });
            card.appendChild(group);
        });
        var resolveBtn = button("Resolve Waivers (" + pending.length + " claim" + (pending.length === 1 ? "" : "s") + ")", "admin-btn", async function () {
            var ok = await confirmDialog(
                "Resolve Week " + currentWeek + " waivers?",
                "Contested claims go to the team with the best waiver priority and the rest are lost. GMs will see whether their claim won.",
                "Resolve"
            );
            if (!ok) return;
            var result = await client.rpc("resolve_waivers", { p_week_number: currentWeek });
            if (result.error) {
                console.error("Portal admin: resolve failed", result.error);
                toast("Couldn't resolve -- try again.", "error");
                return;
            }
            toast("Waivers resolved ✓", "ok");
            render();
        });
        card.appendChild(resolveBtn);
        return card;
    }

    function claimDropText(c) {
        return c.payload.drop_pid ? "drop " + playerName(c.payload.drop_pid) : "no drop (open roster spot)";
    }

    // Won claims still to be entered in BBGM, plus lost ones (nothing to do).
    function renderClaimsToEnter(openClaims, rankByTid) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "3. Waiver claims to enter in BBGM"));
        var won = openClaims.filter(function (c) { return c.status === "won"; })
            .sort(function (a, b) { return (rankByTid[a.tid] || 99) - (rankByTid[b.tid] || 99); });
        var lost = openClaims.filter(function (c) { return c.status === "lost"; });
        var pendingCount = openClaims.filter(function (c) { return c.status === "pending"; }).length;
        if (pendingCount) card.appendChild(el("p", "admin-note", pendingCount + " claim" + (pendingCount === 1 ? " is" : "s are") + " not resolved yet (step 1)."));
        if (!won.length && !pendingCount) card.appendChild(el("p", "placeholder", "Nothing to enter."));
        won.forEach(function (c) {
            var row = el("div", "admin-line");
            row.appendChild(el("span", "admin-line-text", teamLabel(c.tid) + " — add " + playerName(c.payload.add_pid) + ", " + claimDropText(c)));
            card.appendChild(row);
        });
        if (lost.length) {
            var details = el("details", "admin-details");
            details.appendChild(el("summary", "", "Lost claims (nothing to do) — " + lost.length));
            lost.forEach(function (c) {
                details.appendChild(el("p", "admin-line-p", teamLabel(c.tid) + " — wanted " + playerName(c.payload.add_pid)));
            });
            card.appendChild(details);
        }
        return card;
    }

    // Everything GMs have submitted, for troubleshooting only.
    function renderAllRequests(allRequests) {
        var card = el("div", "card");
        var details = el("details", "admin-details");
        details.appendChild(el("summary", "", "All requests (troubleshooting) — " + allRequests.length));
        allRequests.forEach(function (r) {
            var text = r.type === "add_drop" ? "add " + playerName(r.payload.add_pid) + ", " + claimDropText(r)
                : r.type === "ir_toggle" ? playerName(r.payload.pid) + " → " + (r.payload.to_ir ? "IR" : "active")
                : r.type;
            var line = el("p", "admin-line-p", teamLabel(r.tid) + " — " + text + " (" + r.status + ")");
            details.appendChild(line);
        });
        card.appendChild(details);
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
    var irByPid = {};   // pid -> true (on IR) / false (just moved back to active)
    var irRequests = []; // this week's IR requests, to cancel when taking a player off IR

    function renderLineups() {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "4. IR, playing time & lineups to enter in BBGM"));
        var any = false;

        teams.forEach(function (t) {
            var tid = t.tid;
            var mine = lineupRows.filter(function (r) { return r.tid === tid; });
            var orderByPid = {};
            mine.forEach(function (r) { if (r.roster_order !== null && r.roster_order !== undefined) orderByPid[r.pid] = r.roster_order; });
            var ptChanges = mine.filter(function (r) {
                var p = playerByPid[r.pid];
                return r.pt_level && p && p.tid === tid && !irByPid[r.pid] && r.pt_level !== bbgmPtLevel(p.pt_modifier);
            });
            // Players on IR must be set to 0 playing time in BBGM; players just
            // moved back to active need it put back (unless the GM chose a level).
            var irZero = [];
            var irBack = [];
            players.forEach(function (p) {
                if (p.tid !== tid || !(p.pid in irByPid)) return;
                var bbgmLevel = bbgmPtLevel(p.pt_modifier);
                if (irByPid[p.pid] && bbgmLevel !== "0") irZero.push(p.pid);
                var chosen = mine.some(function (r) { return r.pid === p.pid && r.pt_level; });
                if (!irByPid[p.pid] && bbgmLevel === "0" && !chosen) irBack.push(p.pid);
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
            if (!orderChanged && !ptChanges.length && !irZero.length && !irBack.length) return;
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
            irZero.forEach(function (pid) {
                group.appendChild(lineText("On IR", playerName(pid) + " \u2192 set playing time to 0"));
            });
            irBack.forEach(function (pid) {
                group.appendChild(lineText("Back from IR", playerName(pid) + " \u2192 set playing time back to \u2713"));
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

    // Everyone currently on IR, each with a button to take them off (for when a
    // player is activated in BBGM or the GM hasn't moved him back).
    // GMs drop players on the site at once; they are free agents on the site straight away.
    // The commissioner releases each one in BBGM. A row disappears from this list on its own
    // after the next export shows the player gone.
    function renderDrops(drops) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "2. Players to release in BBGM"));
        card.appendChild(el("p", "admin-note",
            "These players are already off the roster and listed as free agents on the site. Release each one in BBGM before the next sim (do this before entering waiver claims). " +
            "They clear from this list after the next export shows them released."));
        if (!drops.length) card.appendChild(el("p", "placeholder", "Nobody to release."));
        drops.forEach(function (d) {
            var row = el("div", "admin-line");
            row.appendChild(el("span", "admin-line-text",
                teamLabel(d.tid) + " \u2014 release " + playerName(d.pid) + " (dropped in week " + d.week_number + ")"));
            row.appendChild(button("Undo drop", "admin-btn admin-btn-small admin-btn-ghost", async function () {
                var ok = await confirmDialog("Undo this drop?",
                    playerName(d.pid) + " goes back on " + teamLabel(d.tid) + "'s roster and leaves the free agent list.", "Undo drop");
                if (!ok) return;
                var del = await client.from("dropped_public").delete().eq("pid", d.pid);
                if (del.error) {
                    console.error("Portal admin: undo drop failed", del.error);
                    toast("Couldn't undo -- try again.", "error");
                    return;
                }
                toast("Drop undone \u2713", "ok");
                render();
            }));
            card.appendChild(row);
        });
        return card;
    }

    function renderOnIr() {
        var card = el("div", "card");
        card.appendChild(el("h3", "", "Currently on IR"));
        var onIr = players.filter(function (p) { return irByPid[p.pid] && p.tid >= 0; });
        if (!onIr.length) {
            card.appendChild(el("p", "placeholder", "Nobody is on IR."));
            return card;
        }
        onIr.forEach(function (p) {
            var row = el("div", "admin-line");
            row.appendChild(el("span", "admin-line-text", teamLabel(p.tid) + " \u2014 " + playerName(p.pid)));
            row.appendChild(button("Take off IR", "admin-btn admin-btn-small", async function () {
                var ok = await confirmDialog("Take " + playerName(p.pid) + " off IR?",
                    "He goes back to the active roster on the site. If his playing time in BBGM is 0, set it back to normal.", "Take off IR");
                if (!ok) return;
                var del = await client.from("ir_public").delete().eq("pid", p.pid);
                var ids = irRequests.filter(function (r) { return r.payload.pid === p.pid && r.payload.to_ir && r.status !== "cancelled"; })
                    .map(function (r) { return r.id; });
                var cancel = ids.length ? await client.from("gm_requests").update({ status: "cancelled" }).in("id", ids) : { error: null };
                if (del.error || cancel.error) {
                    console.error("Portal admin: take off IR failed", del.error, cancel.error);
                    toast("Couldn't save -- try again.", "error");
                    return;
                }
                toast("Taken off IR \u2713", "ok");
                render();
            }));
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
            countNote.textContent = "Automatic: a player is IR-eligible while he is out " + 7 + "+ games (set at each update). Tick a player for a one-off exception; the next update goes back to the automatic rule. " + n + " currently eligible (highlighted green).";
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
                if (p.injury_status && p.injury_status !== "Healthy") label.appendChild(el("span", "admin-chip admin-chip-inj", "INJ \u00b7 " + p.injury_status));
                block.appendChild(label);
            });
            details.appendChild(block);
        });
        card.appendChild(details);
        return card;
    }

    render();
})();
