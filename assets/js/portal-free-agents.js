// Free agents page: shows an "Add" button next to every free agent for a
// signed-in GM. Tapping it (after choosing which team, if the GM has two)
// sends them to that team's roster page, where they pick who to drop --
// see portal-roster.js, which finishes the claim. Nothing is written
// from this page; it only hands off the chosen player.
(async function () {
    await window.Portal.ready;

    // Signing in or out changes whether the Add column should exist.
    document.addEventListener("portal:auth-changed", function () {
        window.location.reload();
    });

    var user = window.Portal.getUser();
    var client = window.Portal.getClient();

    // Players a GM has just dropped on the site are free agents right away, even
    // though the commissioner hasn't released them in BBGM yet. Their rows ship in
    // an inert <template>; reveal the ones in portal.dropped_public (public read).
    var myDroppedPids = {};   // pid -> true, for players this GM dropped (can't be claimed back this week)
    try {
        var droppedResult = await client.from("dropped_public").select("pid,tid,dropped_by,week_number");
        var dropped = droppedResult.data || [];
        var tpl = document.getElementById("fa-rostered");
        var tbody = document.querySelector("table.stats-table tbody");
        var revealed = 0;
        if (tpl && tbody && dropped.length) {
            var templateRows = {};
            Array.prototype.forEach.call(tpl.content.querySelectorAll("tr[data-pid]"), function (tr) {
                templateRows[tr.dataset.pid] = tr;
            });
            dropped.forEach(function (d) {
                var source = templateRows[d.pid];
                if (!source || String(source.dataset.tid) !== String(d.tid)) return;   // already released in BBGM
                if (tbody.querySelector("tr[data-pid='" + d.pid + "']")) return;
                var row = source.cloneNode(true);
                row.classList.add("fa-just-dropped");
                // keep the table in Overall order, like the rest of the page
                var ovr = parseInt(row.dataset.ovr, 10) || 0;
                var before = Array.prototype.find.call(tbody.rows, function (r) { return (parseInt(r.dataset.ovr, 10) || 0) < ovr; });
                tbody.insertBefore(row, before || null);
                revealed++;
                if (user && d.dropped_by === user.id) myDroppedPids[d.pid] = d.week_number;
            });
        }
        var count = document.getElementById("fa-count");
        if (count && revealed) count.textContent = String(parseInt(count.textContent, 10) + revealed);
    } catch (err) {
        console.error("Portal: couldn't load recent drops", err);
    }

    if (!user) return; // signed out -- page stays exactly as generated

    var myTeams = await window.Portal.getMyTeams();
    if (!myTeams.length) return; // signed in, but not a GM with teams here

    // Waivers open once week 1 has been played (the sync then writes a waiver
    // order). Until then the file's priority list is empty: no Add buttons.
    var waiversOpen = false;
    try {
        var res = await fetch("data/waiver_priority.json?t=" + Date.now());
        var data = res.ok ? await res.json() : null;
        waiversOpen = !!(data && data.priority && Object.keys(data.priority).length);
    } catch (err) { /* no file / offline: treat as closed */ }

    if (!waiversOpen) {
        Array.prototype.forEach.call(document.querySelectorAll(".fa-add-hint"), function (el) {
            el.textContent = "Add/drops open after Week 1 is played.";
            el.classList.add("fa-add-closed");
            el.hidden = false;
        });
        return;
    }

    // A GM can't claim back a player they dropped this week (also enforced by the database).
    var stateResult = await client.from("sync_state").select("current_week_number").eq("id", 1).single();
    var thisWeek = stateResult.data ? stateResult.data.current_week_number : null;
    Object.keys(myDroppedPids).forEach(function (pid) {
        if (myDroppedPids[pid] !== thisWeek) return;
        var btn = document.querySelector(".fa-add-btn[data-pid='" + pid + "']");
        if (!btn) return;
        var cell = btn.parentElement;
        btn.remove();
        cell.title = "You dropped this player this week, so you can't claim him back until next week";
        cell.textContent = "";
        var note = document.createElement("span");
        note.className = "fa-dropped-note";
        note.textContent = "Dropped";
        cell.appendChild(note);
    });

    document.body.classList.add("fa-managing");
    Array.prototype.forEach.call(document.querySelectorAll(".fa-add-hint"), function (el) { el.hidden = false; });

    // Clicks go through the table so they keep working after search/sort
    // rearranges the rows.
    document.addEventListener("click", function (e) {
        var btn = e.target.closest(".fa-add-btn");
        if (!btn) return;
        startAdd(btn.dataset.pid, btn.dataset.name);
    });

    function startAdd(pid, name) {
        if (myTeams.length === 1) {
            goToRoster(myTeams[0].tid, pid, name);
        } else {
            openTeamPicker(pid, name);
        }
    }

    function goToRoster(tid, pid, name) {
        var page = "gms/" + user.name.toLowerCase() + ".html";
        window.location.href = page + "?add=" + encodeURIComponent(pid) +
            "&addname=" + encodeURIComponent(name) + "#panel-" + tid;
    }

    var pickerEl = null;

    function openTeamPicker(pid, name) {
        if (!pickerEl) {
            pickerEl = document.createElement("div");
            pickerEl.className = "roster-picker-backdrop";
            pickerEl.hidden = true;
            pickerEl.innerHTML =
                '<div class="roster-picker" role="dialog" aria-modal="true">' +
                '<div class="roster-picker-header">' +
                '<div><h3>Add to which team?</h3><p class="roster-picker-sub"></p></div>' +
                '<button type="button" class="roster-picker-close" aria-label="Close">&times;</button>' +
                "</div>" +
                '<div class="roster-picker-list"></div>' +
                "</div>";
            document.body.appendChild(pickerEl);
            pickerEl.addEventListener("click", function (e) {
                if (e.target === pickerEl || e.target.closest(".roster-picker-close")) pickerEl.hidden = true;
            });
            document.addEventListener("keydown", function (e) {
                if (e.key === "Escape") pickerEl.hidden = true;
            });
        }
        var sub = pickerEl.querySelector(".roster-picker-sub");
        sub.textContent = "";
        var chip = document.createElement("strong");
        chip.className = "picker-player";
        chip.textContent = name;
        sub.appendChild(document.createTextNode("Adding "));
        sub.appendChild(chip);
        sub.appendChild(document.createTextNode(" \u00b7 next you'll choose who to drop, or add without a drop if you have an open roster spot."));
        var list = pickerEl.querySelector(".roster-picker-list");
        list.innerHTML = "";
        myTeams.forEach(function (team) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "roster-picker-option has-logo";
            btn.innerHTML = '<img class="picker-team-logo" alt=""><strong></strong><span></span>';
            var logo = btn.querySelector("img");
            logo.src = "assets/images/bbgm-logos/" + String(team.abbrev).toLowerCase() + "-secondary.png";
            logo.onerror = function () { logo.style.visibility = "hidden"; };
            btn.querySelector("strong").textContent = team.full_name;
            btn.querySelector("span").textContent = team.abbrev;
            btn.addEventListener("click", function () { goToRoster(team.tid, pid, name); });
            list.appendChild(btn);
        });
        pickerEl.hidden = false;
    }
})();
