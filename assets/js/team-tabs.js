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
