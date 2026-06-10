// Shared admin chrome behaviour: hamburger toggle (persisted) + active nav item.
(function () {
  var KEY = 'admin_sb_open';
  var b = document.body;
  function setOpen(o) {
    b.classList.toggle('sb-open', o);
    try { localStorage.setItem(KEY, o ? '1' : '0'); } catch (e) {}
  }
  // default: open on desktop, closed on phone — unless the user set it before
  var stored = null; try { stored = localStorage.getItem(KEY); } catch (e) {}
  setOpen(stored !== null ? stored === '1' : window.innerWidth > 760);

  var btn = document.getElementById('burger');
  if (btn) btn.addEventListener('click', function () {
    setOpen(!b.classList.contains('sb-open'));
  });

  // mark the current page's sidebar link active
  var cur = b.getAttribute('data-page');
  document.querySelectorAll('.asidebar a[data-p]').forEach(function (a) {
    if (a.getAttribute('data-p') === cur) a.classList.add('active');
  });
})();
