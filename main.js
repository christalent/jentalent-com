// Jeni Talent - Notary Public Site
// Main JS - Nav and utilities

function toggleMobileMenu() {
  document.getElementById('mobileMenu').classList.toggle('show');
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function(e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});