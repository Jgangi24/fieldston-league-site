// Switches which team's panel is visible on a GM page, and highlights
// the clicked tab. Simple show/hide -- no data is saved, this is purely
// a display toggle so both teams don't have to be scrolled through at once.
function showTeamPanel(clickedTab, targetId) {
    document.querySelectorAll('.team-panel').forEach(function (panel) {
        panel.style.display = panel.id === targetId ? '' : 'none';
    });
    document.querySelectorAll('.team-tab').forEach(function (tab) {
        tab.classList.remove('active');
    });
    clickedTab.classList.add('active');
}

// If the page was linked to with a #panel-<tid> hash (e.g. from the
// homepage standings table), activate that team's tab on load instead
// of always defaulting to the first team.
document.addEventListener('DOMContentLoaded', function () {
    var targetId = window.location.hash.slice(1);
    if (!targetId) return;
    var tab = document.querySelector('.team-tab[data-target="' + targetId + '"]');
    if (tab) showTeamPanel(tab, targetId);
});
