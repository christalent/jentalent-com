// Jenifer Talent - Notary Public Site
// Main JS - Nav and utilities

(function () {
  'use strict';

  function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (!menu) return;
    const open = menu.classList.toggle('show');
    const btn = document.querySelector('.mobile-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function initMobileMenu() {
    const btn = document.querySelector('.mobile-menu-btn');
    if (btn) {
      btn.addEventListener('click', toggleMobileMenu);
    }

    const menu = document.getElementById('mobileMenu');
    if (!menu) return;

    // Close the menu after choosing a destination.
    menu.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        menu.classList.remove('show');
        const button = document.querySelector('.mobile-menu-btn');
        if (button) button.setAttribute('aria-expanded', 'false');
      });
    });

    // Close on Escape.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('show')) {
        menu.classList.remove('show');
        const button = document.querySelector('.mobile-menu-btn');
        if (button) button.setAttribute('aria-expanded', 'false');
        if (btn) btn.focus();
      }
    });
  }

  // Smooth scroll for anchor links
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', function (e) {
        const hash = this.getAttribute('href');
        if (!hash || hash === '#') return;
        let target = null;
        try {
          target = document.querySelector(hash);
        } catch (err) {
          return; // Not a valid selector — let the browser handle it.
        }
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth' });
        }
      });
    });
  }

  function init() {
    initMobileMenu();
    initSmoothScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
