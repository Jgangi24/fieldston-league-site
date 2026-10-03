// Shared sign-in widget + Supabase session handling, loaded on every page
// via templates/nav.html. Other portal scripts (portal-roster.js,
// portal-free-agents.js, the admin dashboard) wait on window.Portal.ready
// and then use window.Portal.getClient() / getUser() / getMyTeams().
window.Portal = (function () {
    var SUPABASE_URL = "https://nzydysnununphiobnirq.supabase.co";
    var SUPABASE_ANON_KEY = "sb_publishable_1G76RJgZH-JcOeC2r6etAg_DBNZCGGJ";

    var client = null;
    var currentUser = null; // {id, name, is_commissioner} or null when signed out
    var readyResolve;
    var ready = new Promise(function (resolve) { readyResolve = resolve; });

    // Every page's <link> to style.css already carries the correct
    // ""/"../"/"../../" prefix for that page's folder depth -- reusing it
    // here means this one shared JS file works everywhere without needing
    // to be templated per page like the HTML is.
    function rootPrefix() {
        var link = document.querySelector('link[rel="stylesheet"][href$="assets/css/style.css"]');
        if (!link) return "";
        return link.getAttribute("href").replace(/assets\/css\/style\.css$/, "");
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text == null ? "" : String(text);
        return div.innerHTML;
    }

    async function loadGmProfile(authUser) {
        if (!authUser) return null;
        var result = await client.from("gms").select("id,name,is_commissioner").eq("id", authUser.id).single();
        if (result.error) {
            console.error("Portal: failed to load gm profile", result.error);
            return null;
        }
        return result.data;
    }

    // Once the first load has finished, any later change of who's signed
    // in fires "portal:auth-changed" on document so other portal scripts
    // (roster controls, free agents, admin) can react without a manual
    // page refresh. Token refreshes for the same user don't fire it.
    var initialized = false;
    var knownUserId = null; // who the rest of the page last heard about

    async function refreshSession() {
        var sessionResult = await client.auth.getSession();
        var authUser = sessionResult.data.session ? sessionResult.data.session.user : null;
        currentUser = await loadGmProfile(authUser);
        renderWidget();
        var currentId = currentUser ? currentUser.id : null;
        if (initialized && currentId !== knownUserId) {
            knownUserId = currentId;
            document.dispatchEvent(new CustomEvent("portal:auth-changed", { detail: { user: currentUser } }));
        }
        return currentUser;
    }

    // Closes the popover on a click outside the whole widget -- not just
    // outside the toggle button, which was the bug: a click on the email
    // field, password field, or submit button inside the popover also
    // bubbles up to document, so scoping this to the widget's full bounds
    // (not just the toggle) is what keeps clicks inside it from closing it.
    function closeMenuIfOutside(e) {
        var widget = document.getElementById("portal-auth-widget");
        if (widget && !widget.contains(e.target)) {
            var menu = widget.querySelector(".portal-auth-menu");
            if (menu) menu.hidden = true;
        }
    }

    function renderWidget() {
        var mount = document.getElementById("portal-auth-widget");
        if (!mount) return;
        var root = rootPrefix();

        if (currentUser) {
            mount.innerHTML =
                '<button type="button" class="portal-auth-toggle">Hi, ' + escapeHtml(currentUser.name) + " &#9662;</button>" +
                '<div class="portal-auth-menu" hidden>' +
                (currentUser.is_commissioner
                    ? '<a href="' + root + 'admin.html">Admin Dashboard</a>'
                    : "") +
                '<button type="button" data-action="sign-out">Sign out</button>' +
                "</div>";

            mount.querySelector(".portal-auth-toggle").addEventListener("click", function (e) {
                e.stopPropagation();
                var menu = mount.querySelector(".portal-auth-menu");
                menu.hidden = !menu.hidden;
            });
            mount.querySelector('[data-action="sign-out"]').addEventListener("click", function () {
                client.auth.signOut();
            });
        } else {
            mount.innerHTML =
                '<button type="button" class="portal-auth-toggle">Sign in</button>' +
                '<div class="portal-auth-menu" hidden>' +
                '<form class="portal-auth-form">' +
                '<input type="email" name="email" placeholder="Email" autocomplete="username" required>' +
                '<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>' +
                '<button type="submit">Sign in</button>' +
                '<p class="portal-auth-error" hidden></p>' +
                "</form>" +
                "</div>";

            mount.querySelector(".portal-auth-toggle").addEventListener("click", function (e) {
                e.stopPropagation();
                var menu = mount.querySelector(".portal-auth-menu");
                menu.hidden = !menu.hidden;
            });
            mount.querySelector(".portal-auth-form").addEventListener("submit", async function (e) {
                e.preventDefault();
                var form = e.target;
                var errorEl = form.querySelector(".portal-auth-error");
                errorEl.hidden = true;
                var email = form.email.value.trim();
                var password = form.password.value;
                var result = await client.auth.signInWithPassword({ email: email, password: password });
                if (result.error) {
                    errorEl.textContent = "Wrong email or password.";
                    errorEl.hidden = false;
                }
                // On success, onAuthStateChange below re-renders the widget.
            });
        }
    }

    document.addEventListener("click", closeMenuIfOutside);

    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        db: { schema: "portal" },
    });

    client.auth.onAuthStateChange(function () {
        refreshSession();
    });

    refreshSession().then(function () {
        initialized = true;
        knownUserId = currentUser ? currentUser.id : null;
        readyResolve({ client: client, user: currentUser });
    });

    return {
        ready: ready,
        getClient: function () { return client; },
        getUser: function () { return currentUser; },
        // A GM's two teams -- {} if signed out or not a GM.
        getMyTeams: async function () {
            if (!currentUser) return [];
            var result = await client.from("teams_mirror").select("tid,abbrev,full_name").eq("gm_id", currentUser.id);
            if (result.error) {
                console.error("Portal: failed to load my teams", result.error);
                return [];
            }
            return result.data;
        },
    };
})();
