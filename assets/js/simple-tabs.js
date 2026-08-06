// Generic tab-group switcher, used for:
//  - Team Stats window toggle on GM pages (Last 7 / Last 14 / Full Season)
//  - Player page tabs (Game Log / Season Stats)
// A link with data-tab-link, data-tab-group="X", data-tab-target="Y"
// shows the panel with data-tab-panel-group="X" data-tab-panel="Y" and
// hides its sibling panels in that same group.
document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-tab-link]').forEach(function (link) {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            var group = link.dataset.tabGroup;
            var target = link.dataset.tabTarget;

            document.querySelectorAll('[data-tab-link][data-tab-group="' + group + '"]').forEach(function (l) {
                l.classList.toggle('active', l === link);
            });
            document.querySelectorAll('[data-tab-panel-group="' + group + '"]').forEach(function (panel) {
                panel.style.display = (panel.dataset.tabPanel === target) ? '' : 'none';
            });
        });
    });
});
