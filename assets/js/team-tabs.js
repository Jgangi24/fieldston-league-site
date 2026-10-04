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
    if (!tab) return;
    showTeamPanel(tab, targetId);

    // The #panel-<tid> hash makes the browser jump DOWN to that panel, past the GM's name,
    // team tabs, waiver priority and the Free agents link. Those are the controls people
    // want first, so always start at the top of the page. Removing the hash from the address
    // stops the browser from scrolling to it (even after the page finishes loading); other
    // scripts that need to know which panel was linked read window.linkedPanelHash.
    window.linkedPanelHash = window.location.hash;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    window.scrollTo(0, 0);
});
