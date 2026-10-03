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
        sub.appendChild(document.createTextNode(" \u00b7 you'll choose who to drop next."));
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
