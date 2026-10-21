/* Sidebar behaviour + cursor trail, matching the ACE Staff Portal look.
   Loaded last so it can wrap showView / updateUserIndicator without touching them. */
(function () {
  var currentView = 'home';
  var SECTION_TITLES = ['Admissions Pipeline', 'Coverage Schedule', 'Email Accounts', 'Recent Activity', 'Upcoming Interviews'];

  /* Find the dashboard card for a section by its heading (email card is found by id). */
  function sectionEl(key) {
    if (key === 'overview') return document.getElementById('view-dashboard');
    if (key === 'Email Accounts') return document.getElementById('email-accounts-card');
    var hs = document.querySelectorAll('#view-dashboard h3');
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].textContent.trim() === key) return hs[i].closest('.neu-raised');
    }
    return null;
  }

  window.adminJump = function (key) {
    if (currentView !== 'dashboard') window.showView('dashboard');
    var el = sectionEl(key);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: key === 'overview' ? 'start' : 'start' });
    setActive(key);
    closeMenu();
  };

  function setActive(key) {
    if (!sidebar) return;
    sidebar.querySelectorAll('.nav-item[data-nav]').forEach(function (el) {
      el.classList.toggle('is-active', el.getAttribute('data-nav') === key);
    });
  }

  function closeMenu() {
    document.body.classList.remove('menu-open');
    var t = document.getElementById('menu-toggle');
    if (t) t.setAttribute('aria-expanded', 'false');
  }

  /* The sidebar is only in the page while an admin is signed in. */
  var sidebar = document.getElementById('sidebar');
  var shell = document.querySelector('.app-shell');
  var sidebarMark = document.createComment('sidebar (admin only)');
  if (sidebar && sidebar.parentNode) sidebar.parentNode.insertBefore(sidebarMark, sidebar);

  function syncNav() {
    var isAdmin = typeof adminAuthenticated !== 'undefined' && adminAuthenticated;
    if (sidebar) {
      if (isAdmin && !sidebar.isConnected) sidebarMark.parentNode.insertBefore(sidebar, sidebarMark.nextSibling);
      if (!isAdmin && sidebar.isConnected) {
        var inSidebar = document.querySelector('.sidebar #user-indicator');
        var pub = document.getElementById('public-user-slot');
        if (inSidebar && pub) pub.appendChild(inSidebar);
        sidebar.remove();
      }
    }
    document.body.classList.toggle('has-sidebar', !!isAdmin);
    if (!isAdmin) closeMenu();
    /* one #user-indicator: sidebar for admins, top bar for parents/students */
    var ind = document.getElementById('user-indicator');
    var slot = isAdmin ? sidebar.querySelector('.sidebar-foot') : document.getElementById('public-user-slot');
    if (ind && slot && ind.parentNode !== slot) slot.appendChild(ind);
    if (isAdmin && currentView === 'dashboard' && !sidebar.querySelector('.is-active')) setActive('overview');
    if (currentView !== 'dashboard') setActive(null);
  }

  if (typeof window.showView === 'function') {
    var origShow = window.showView;
    window.showView = function (view) {
      currentView = view;
      origShow.apply(this, arguments);
      syncNav();
      closeMenu();
      window.scrollTo(0, 0);
    };
  }
  if (typeof window.updateUserIndicator === 'function') {
    var origInd = window.updateUserIndicator;
    window.updateUserIndicator = function () {
      origInd.apply(this, arguments);
      syncNav();
    };
  }

  var toggle = document.getElementById('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('menu-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  var backdrop = document.createElement('div');
  backdrop.className = 'menu-backdrop';
  backdrop.addEventListener('click', closeMenu);
  document.body.appendChild(backdrop);

  syncNav();

  /* scroll-spy: highlight the dashboard section nearest the top */
  window.addEventListener('scroll', function () {
    if (currentView !== 'dashboard' || !sidebar || !sidebar.isConnected) return;
    var best = 'overview', bestTop = -Infinity;
    SECTION_TITLES.forEach(function (k) {
      var el = sectionEl(k); if (!el) return;
      var t = el.getBoundingClientRect().top;
      if (t <= 140 && t > bestTop) { best = k; bestTop = t; }
    });
    setActive(best);
  }, { passive: true });

  /* ---- cursor trail: glowing particles that follow the pointer ---- */
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var canvas = document.createElement('canvas');
  canvas.className = 'cursor-trail-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  var PALETTE = ['#2d6cdf', '#60a5fa', '#ffffff', '#22c55e', '#4ade80'];
  var particles = [], rafId = null, width = 0, height = 0;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    width = window.innerWidth; height = window.innerHeight;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(x, y, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.8;
      particles.push({
        x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 6,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.4,
        radius: 2 + Math.random() * 3.5,
        color: PALETTE[(Math.random() * PALETTE.length) | 0],
        life: 1, decay: 0.016 + Math.random() * 0.016
      });
    }
    if (particles.length > 220) particles = particles.slice(-220);
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }
  function tick() {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    particles = particles.filter(function (p) { return p.life > 0; });
    particles.forEach(function (p) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.015; p.vx *= 0.985; p.life -= p.decay;
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0, p.radius * p.life), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    rafId = particles.length ? requestAnimationFrame(tick) : null;
  }
  var last = 0;
  document.addEventListener('pointermove', function (e) {
    var now = performance.now();
    if (now - last < 16) return;
    last = now;
    spawn(e.clientX, e.clientY, 3);
  }, { passive: true });
  window.addEventListener('resize', resize, { passive: true });
  resize();
})();
