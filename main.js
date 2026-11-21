// Jenifer Talent - Notary Public Site
// Main JS - Nav and utilities

(function () {
  'use strict';

  function closeMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (!menu) return;
    menu.classList.remove('show');
    const button = document.querySelector('.mobile-menu-btn');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

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
      link.addEventListener('click', closeMobileMenu);
    });

    // Close on Escape.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('show')) {
        closeMobileMenu();
        if (btn) btn.focus();
      }
    });

    // Close on a click outside the menu and the toggle button. Without this
    // an open menu stays over the content the user just tapped.
    document.addEventListener('click', (event) => {
      if (!menu.classList.contains('show')) return;
      if (menu.contains(event.target)) return;
      if (btn && btn.contains(event.target)) return;
      closeMobileMenu();
    });

    // Close on scroll — an open menu pinned over the page is in the way.
    window.addEventListener('scroll', () => {
      if (menu.classList.contains('show')) closeMobileMenu();
    }, { passive: true });

    // Close when the viewport grows past the mobile breakpoint and the
    // desktop nav takes over.
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768 && menu.classList.contains('show')) {
        closeMobileMenu();
      }
    });
  }

  function init() {
    initMobileMenu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
