/**
 * screen2.js — Language Selection (Screen 2)
 * Continue button inactive until language selected
 * Stores language name + BCP-47 code in sessionStorage for Screen 3
 */

document.addEventListener('DOMContentLoaded', () => {
  const cards       = document.querySelectorAll('.lang-card');
  const continueBtn = document.getElementById('continue-btn');

  cards.forEach(card => {
    card.addEventListener('click', () => {
      cards.forEach(c => {
        c.classList.remove('selected');
        c.setAttribute('aria-pressed', 'false');
      });
      card.classList.add('selected');
      card.setAttribute('aria-pressed', 'true');
      continueBtn.disabled = false;
    });
  });

  continueBtn.addEventListener('click', () => {
    const selected = document.querySelector('.lang-card.selected');
    if (!selected) return;
    sessionStorage.setItem('mvfhis_language',      selected.dataset.language);
    sessionStorage.setItem('mvfhis_language_code', selected.dataset.code);
    window.location.href = 'screen3-record.html';
  });
});
