/**
 * Login — al hacer clic en el logo: vuela a la esquina inferior derecha
 * y luego desciende lentamente desde el centro a su posición original.
 */
(function loginLogoFly() {
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  function el() {
    return document.querySelector('#view-login .logo-app');
  }

  function wait(anim) {
    return anim && typeof anim.finished !== 'undefined'
      ? anim.finished.catch(() => {})
      : Promise.resolve();
  }

  async function play(logo) {
    if (!logo || logo.dataset.flying === '1' || REDUCED.matches) return;
    if (typeof logo.animate !== 'function') return;

    const wrap = logo.parentElement;
    if (!wrap) return;

    const rect = logo.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;

    logo.dataset.flying = '1';

    const ph = document.createElement('div');
    ph.className = 'login-logo-placeholder';
    ph.style.width = `${rect.width}px`;
    ph.style.height = `${rect.height}px`;
    wrap.insertBefore(ph, logo);

    logo.classList.add('logo-app--flying');
    Object.assign(logo.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      zIndex: '60',
      animation: 'none',
      pointerEvents: 'none',
      willChange: 'transform, opacity',
    });

    const margin = 20;
    const toBrX = window.innerWidth - rect.width - margin - rect.left;
    const toBrY = window.innerHeight - rect.height - margin - rect.top;
    const toCenterX = (window.innerWidth - rect.width) / 2 - rect.left;
    const toCenterY = Math.max(28, window.innerHeight * 0.1) - rect.top;

    try {
      await wait(
        logo.animate(
          [
            { transform: 'translate(0, 0) rotate(0deg) scale(1)', offset: 0 },
            {
              transform: `translate(${toBrX * 0.45}px, ${toBrY * 0.15 - 48}px) rotate(-18deg) scale(1.08)`,
              offset: 0.4,
            },
            {
              transform: `translate(${toBrX}px, ${toBrY}px) rotate(12deg) scale(0.82)`,
              offset: 1,
            },
          ],
          {
            duration: 980,
            easing: 'cubic-bezier(0.22, 0.82, 0.28, 1)',
            fill: 'forwards',
          }
        )
      );

      await wait(
        logo.animate(
          [
            {
              transform: `translate(${toBrX}px, ${toBrY}px) rotate(12deg) scale(0.82)`,
              opacity: 1,
              offset: 0,
            },
            {
              transform: `translate(${toBrX}px, ${toBrY}px) rotate(20deg) scale(0.55)`,
              opacity: 0,
              offset: 0.18,
            },
            {
              transform: `translate(${toCenterX}px, ${toCenterY}px) rotate(0deg) scale(0.9)`,
              opacity: 0,
              offset: 0.19,
            },
            {
              transform: `translate(${toCenterX}px, ${toCenterY}px) rotate(0deg) scale(1.06)`,
              opacity: 1,
              offset: 0.32,
            },
            {
              transform: 'translate(0, 0) rotate(0deg) scale(1)',
              opacity: 1,
              offset: 1,
            },
          ],
          {
            duration: 2400,
            easing: 'cubic-bezier(0.33, 0.1, 0.25, 1)',
            fill: 'forwards',
          }
        )
      );
    } finally {
      logo.getAnimations?.().forEach((a) => a.cancel());
      logo.classList.remove('logo-app--flying');
      logo.removeAttribute('style');
      ph.remove();
      delete logo.dataset.flying;
    }
  }

  function bind(logo) {
    if (!logo || logo.dataset.flyBound === '1') return;
    logo.dataset.flyBound = '1';
    logo.classList.add('logo-app--interactive');
    if (!logo.hasAttribute('tabindex')) logo.setAttribute('tabindex', '0');
    if (!logo.getAttribute('role')) logo.setAttribute('role', 'button');
    if (!logo.getAttribute('aria-label')) {
      logo.setAttribute('aria-label', 'Animar logo');
    }

    logo.addEventListener('click', (e) => {
      e.preventDefault();
      play(logo);
    });
    logo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        play(logo);
      }
    });
  }

  function init() {
    bind(el());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
