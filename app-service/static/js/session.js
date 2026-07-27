/**
 * session.js — MVFHIS Session Security
 * PRD Section 6: Two simultaneous timers
 *   - Inactivity timer: 15 minutes — resets on any user interaction
 *   - Absolute timer:   40 minutes from login — fires regardless of activity
 * Both call /.auth/logout (Azure Easy Auth endpoint)
 * Required under PIPEDA and PHIPA for shared clinic tablets
 *
 * v2 improvements:
 * - pauseInactivity() / resumeInactivity() — Screen 4 pauses the inactivity
 *   timer while polling is active so patients don't get logged out mid-processing
 * - Silent session keep-alive on Screen 4 — no warning modal shown while waiting
 * - Network reconnect now shows a brief "Reconnected" confirmation before hiding banner
 */

const SESSION = (() => {
  const INACTIVITY_MS  = 15 * 60 * 1000;
  const ABSOLUTE_MS    = 40 * 60 * 1000;
  const WARN_BEFORE_MS =  2 * 60 * 1000;

  let inactivityTimer = null;
  let absoluteTimer   = null;
  let warnTimer       = null;
  let warningShown    = false;
  let paused          = false;  // v2: allows Screen 4 to pause inactivity timer

  function logout(reason) {
    console.log('[Session] Logging out:', reason);
    clearTimeout(inactivityTimer);
    clearTimeout(absoluteTimer);
    clearTimeout(warnTimer);
    window.location.href = '/.auth/logout?post_logout_redirect_uri=/';
  }

  function hideWarningModal() {
    const modal = document.getElementById('session-warning-modal');
    if (modal) modal.classList.remove('visible');
  }

  function showWarningModal() {
    // v2: never show warning modal if inactivity is paused (Screen 4)
    if (warningShown || paused) return;
    warningShown = true;
    const modal = document.getElementById('session-warning-modal');
    if (modal) modal.classList.add('visible');
  }

  function resetInactivity() {
    if (paused) return; // v2: ignore interaction events while paused
    clearTimeout(inactivityTimer);
    clearTimeout(warnTimer);
    warningShown = false;
    hideWarningModal();
    warnTimer       = setTimeout(showWarningModal, INACTIVITY_MS - WARN_BEFORE_MS);
    inactivityTimer = setTimeout(() => logout('inactivity'), INACTIVITY_MS);
  }

  function start() {
    ['click', 'touchstart', 'keydown', 'scroll', 'mousemove'].forEach(evt => {
      document.addEventListener(evt, resetInactivity, { passive: true });
    });
    resetInactivity();
    absoluteTimer = setTimeout(() => logout('absolute-timeout'), ABSOLUTE_MS);
    console.log('[Session] Started — inactivity: 15min, absolute: 40min');
  }

  function stayActive() {
    resetInactivity();
  }

  // v2: Screen 4 calls this while polling is active
  // Clears the inactivity timer so patient can't be logged out mid-processing
  // The absolute 40-min timer still runs — PRD compliance maintained
  function pauseInactivity() {
    paused = true;
    clearTimeout(inactivityTimer);
    clearTimeout(warnTimer);
    hideWarningModal();
    console.log('[Session] Inactivity timer paused — processing screen active');
  }

  // v2: Screen 4 calls this if polling stops (error / complete)
  function resumeInactivity() {
    paused = false;
    resetInactivity();
    console.log('[Session] Inactivity timer resumed');
  }

  return { start, stayActive, logout, pauseInactivity, resumeInactivity };
})();

/* ── Network watcher ── */
const NETWORK = (() => {
  let reconnectTimer = null;

  function update() {
    const banner = document.getElementById('network-banner');
    if (!banner) return;

    if (!navigator.onLine) {
      clearTimeout(reconnectTimer);
      banner.textContent = 'No internet connection. Please check your network and try again.';
      banner.style.background = '';
      banner.style.color = '';
      banner.classList.add('visible');
    } else {
      // v2: brief "Reconnected" confirmation before hiding
      clearTimeout(reconnectTimer);
      banner.textContent = 'Reconnected — continuing…';
      banner.style.background = 'var(--success-bg)';
      banner.style.color      = 'var(--success)';
      banner.style.borderColor = 'var(--success)';
      banner.classList.add('visible');
      reconnectTimer = setTimeout(() => {
        banner.classList.remove('visible');
        banner.style.background  = '';
        banner.style.color       = '';
        banner.style.borderColor = '';
      }, 2500);
    }
  }

  function init() {
    window.addEventListener('online',  update);
    window.addEventListener('offline', update);
    update();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  SESSION.start();
  NETWORK.init();
});
