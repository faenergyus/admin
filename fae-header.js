/* fae-header.js — the SINGLE shared cross-app nav for the 40ac.us apps.
 *
 * One source of truth for the app switcher (Analyst / SCADA / Forms / Admin).
 * Hosted on admin.40ac.us; every app loads it cross-origin:
 *     <script src="https://admin.40ac.us/fae-header.js"></script>
 * (admin pages can use the relative path "fae-header.js").
 *
 * Usage: put a mount in the header where the nav should appear —
 *     <span class="fae-appnav" data-current="analyst"></span>
 * data-current is one of: analyst | scada | forms | admin (the current app;
 * its item renders bold and non-clickable, matching the app convention where
 * the bold trio item is the page title).
 *
 * The "Admin" item is hidden unless the signed-in user's role is admin. This is
 * a UI convenience only — admin.40ac.us is enforced server-side (get_admin);
 * role is read live via window.faeAuth (loaded by every app), never baked in.
 *
 * To add/remove an app or change visibility, edit THIS file only.
 */
(function () {
  var APPS = [
    { id: 'analyst', label: 'Analyst', url: 'https://analyst.40ac.us' },
    { id: 'scada',   label: 'SCADA',   url: 'https://scada.40ac.us'   },
    { id: 'forms',   label: 'Forms',   url: 'https://forms.40ac.us'   },
    { id: 'admin',   label: 'Admin',   url: 'https://admin.40ac.us', adminOnly: true },
  ];

  function injectStyle() {
    if (document.getElementById('fae-appnav-css')) return;
    var st = document.createElement('style');
    st.id = 'fae-appnav-css';
    st.textContent =
      '.fae-appnav{display:flex;align-items:center;gap:16px;margin-left:18px}' +
      '.fae-appnav a{font-size:.82rem;font-weight:600;color:#1a1a1a;' +
        'text-decoration:none;white-space:nowrap;cursor:pointer}' +
      '.fae-appnav a:hover{color:#c0392b}' +
      '.fae-appnav a.cur{font-weight:800;color:#1a1a1a;cursor:default}' +
      '.fae-appnav a.cur:hover{color:#1a1a1a}' +
      '.fae-appnav a[data-admin]{display:none}' +     /* hidden until role confirmed */
      '@media (max-width:760px){.fae-appnav{gap:12px;margin-left:10px}}';
    document.head.appendChild(st);
  }

  function render(mount) {
    var cur = mount.getAttribute('data-current') || '';
    mount.innerHTML = APPS.map(function (a) {
      var isCur = a.id === cur;
      return '<a' + (isCur ? ' class="cur"' : '') +
             (a.adminOnly ? ' data-admin="1"' : '') +
             (isCur ? '' : ' href="' + a.url + '"') + '>' + a.label + '</a>';
    }).join('');
  }

  function revealAdmin(show) {
    document.querySelectorAll('.fae-appnav a[data-admin]').forEach(function (a) {
      a.style.display = show ? '' : 'none';
    });
  }

  function boot() {
    injectStyle();
    var mounts = document.querySelectorAll('.fae-appnav');
    if (!mounts.length) return;
    mounts.forEach(render);
    // Gate the Admin item on role=admin (live lookup via the shared auth helper).
    try {
      if (window.faeAuth) {
        if (window.faeAuth.userRole && window.faeAuth.userRole() === 'admin') revealAdmin(true);
        if (window.faeAuth.ensureUserRole) {
          window.faeAuth.ensureUserRole().then(function (role) { revealAdmin(role === 'admin'); })
            .catch(function () {});
        }
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
