// ── Scroll Reveal Animation ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Animate cards on scroll
  const cards = document.querySelectorAll('.ipo-card, .glass-card, .upcoming-card, .stat-card');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        entry.target.style.transitionDelay = `${i * 40}ms`;
        entry.target.classList.add('reveal');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });

  cards.forEach(card => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(24px)';
    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease, border-color 0.25s ease, box-shadow 0.25s ease';
    observer.observe(card);
  });

  // Inject reveal style
  const style = document.createElement('style');
  style.textContent = '.reveal { opacity: 1 !important; transform: translateY(0) !important; }';
  document.head.appendChild(style);

  // ── Progress bar animation on detail page ───────────────────────
  const bars = document.querySelectorAll('.progress-fill');
  if (bars.length > 0) {
    const barObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // Width is already set inline, just trigger transition
          entry.target.style.transition = 'width 1.2s cubic-bezier(0.4,0,0.2,1)';
          barObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });
    bars.forEach(bar => barObserver.observe(bar));
  }

  // ── Active nav highlighting ──────────────────────────────────────
  const currentPath = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (href === '/' && currentPath === '/')) {
      link.classList.add('active');
    }
  });

  // ── Return Calculator init ───────────────────────────────────────
  if (typeof calculateReturn === 'function') {
    calculateReturn();
  }

  // ── Smooth number counter for stats ─────────────────────────────
  document.querySelectorAll('.stat-value').forEach(el => {
    const text = el.textContent.trim();
    const numMatch = text.match(/[\d.]+/);
    if (!numMatch) return;
    const num = parseFloat(numMatch[0]);
    if (isNaN(num) || num > 10000) return;
    const prefix = text.replace(numMatch[0], '').split(numMatch[0])[0];
    const suffix = text.slice(text.indexOf(numMatch[0]) + numMatch[0].length);
    let start = 0;
    const duration = 1200;
    const step = (timestamp) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = num % 1 === 0 ? Math.floor(eased * num) : (eased * num).toFixed(2);
      el.textContent = prefix + current + suffix;
      if (progress < 1) requestAnimationFrame(step);
    };
    // Delay slightly so it coincides with reveal
    setTimeout(() => requestAnimationFrame(step), 400);
  });
});
