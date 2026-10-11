// Transactions page: lists every add/drop and drop from portal.transactions (public read),
// newest first, grouped by week. The database fills that table by itself when waivers are
// resolved and when a GM drops a player.
(async function () {
    var listEl = document.getElementById("txn-list");
    var teams = {};
    try { teams = JSON.parse(document.getElementById("txn-teams").textContent); } catch (err) { /* names fall back to #tid */ }

    await window.Portal.ready;
    var result = await window.Portal.getClient().from("transactions")
        .select("id,kind,tid,week_number,add_pid,add_name,drop_pid,drop_name,happened_at")
        .order("happened_at", { ascending: false });
    if (result.error) {
        console.error("Portal: couldn't load transactions", result.error);
        listEl.innerHTML = "";
        listEl.appendChild(note("Couldn't load transactions — try again in a moment."));
        return;
    }

    var rows = result.data || [];
    listEl.innerHTML = "";
    if (!rows.length) {
        listEl.appendChild(note("No moves yet this season."));
        return;
    }

    var byWeek = {};
    rows.forEach(function (r) { (byWeek[r.week_number] = byWeek[r.week_number] || []).push(r); });
    Object.keys(byWeek).map(Number).sort(function (a, b) { return b - a; }).forEach(function (week) {
        var card = document.createElement("section");
        card.className = "banner-card";
        var head = document.createElement("div");
        head.className = "banner-head";
        var title = document.createElement("strong");
        title.textContent = "Week " + week;
        head.appendChild(title);
        card.appendChild(head);
        byWeek[week].forEach(function (r) { card.appendChild(renderRow(r)); });
        listEl.appendChild(card);
    });

    function note(text) {
        var p = document.createElement("p");
        p.className = "placeholder";
        p.textContent = text;
        return p;
    }

    function renderRow(r) {
        var team = teams[String(r.tid)] || { name: "Team " + r.tid, abbrev: "", gm: "" };
        var row = document.createElement("div");
        row.className = "txn-row";

        var who = document.createElement("a");
        who.className = "txn-team";
        who.href = "gms/" + (team.gm ? team.gm.toLowerCase() : "") + ".html#panel-" + r.tid;
        var logo = document.createElement("img");
        logo.className = "tm-logo";
        logo.alt = "";
        logo.src = "assets/images/bbgm-logos/" + String(team.abbrev).toLowerCase() + "-secondary.png";
        logo.onerror = function () { logo.style.visibility = "hidden"; };
        var name = document.createElement("span");
        name.textContent = team.name;
        var gm = document.createElement("small");
        gm.textContent = team.gm;
        var nameWrap = document.createElement("span");
        nameWrap.className = "txn-team-name";
        nameWrap.appendChild(name);
        nameWrap.appendChild(gm);
        who.appendChild(logo);
        who.appendChild(nameWrap);

        var what = document.createElement("div");
        what.className = "txn-what";
        if (r.add_pid) what.appendChild(move("Added", r.add_name || "#" + r.add_pid, r.add_pid, "txn-add"));
        if (r.drop_pid) what.appendChild(move("Dropped", r.drop_name || "#" + r.drop_pid, r.drop_pid, "txn-drop"));

        var when = document.createElement("span");
        when.className = "txn-when";
        when.textContent = new Date(r.happened_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

        row.appendChild(who);
        row.appendChild(what);
        row.appendChild(when);
        return row;
    }

    function move(label, playerName, pid, cls) {
        var line = document.createElement("div");
        line.className = "txn-move " + cls;
        var tag = document.createElement("b");
        tag.textContent = label;
        var link = document.createElement("a");
        link.href = "players/" + pid + ".html";
        link.textContent = playerName;
        line.appendChild(tag);
        line.appendChild(link);
        return line;
    }
})();
