/**
 * screen5.js — PDF Download Screen (Screen 5)
 * PRD:
 * - Large Download button
 * - 90-day retention note
 * - SAS link expires in 1 hour
 * - Expired SAS → Refresh button → new SAS URL from /api/status
 * - 90 days passed → staff message
 * - Network disconnect during download → error message
 * - Done button → logout
 *
 * v2 improvements:
 * - Countdown timer only appears when under 10 minutes remaining
 *   Before that, patient just sees "Download available for the next hour"
 *   Avoids alarming elderly patients with a countdown from 60:00
 */

document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn    = document.getElementById('download-btn');
  const refreshBtn     = document.getElementById('refresh-btn');
  const errorBanner    = document.getElementById('error-banner');
  const sasTimerEl     = document.getElementById('sas-timer');
  const sasTimerWrap   = document.getElementById('sas-timer-wrap');   // v2
  const sasStaticNote  = document.getElementById('sas-static-note');  // v2

  const API_BASE       = '';  // same origin via App Gateway → APIM → App Service
  const SAS_EXPIRY_MS  = 30 * 60 * 1000; // 30 min (matches backend User Delegation SAS)
  const SHOW_TIMER_MS  = 10 * 60 * 1000; // v2: only show countdown under 10 min

  let downloadUrl  = sessionStorage.getItem('mvfhis_download_url');
  let downloadTime = parseInt(sessionStorage.getItem('mvfhis_download_time') || '0', 10);
  const submissionId = sessionStorage.getItem('mvfhis_submission_id');
  const patientEmail = sessionStorage.getItem('mvfhis_patient_email') || '';

  let sasTimerInterval = null;

  // ── Helpers ───────────────────────────────────────────────
  function showError(msg, showRefresh = false) {
    errorBanner.textContent = msg;
    errorBanner.classList.add('visible');
    if (showRefresh) refreshBtn.style.display = 'flex';
  }

  function hideError() {
    errorBanner.classList.remove('visible');
    refreshBtn.style.display = 'none';
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60).toString().padStart(2, '0');
    const s = (total % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function markExpired() {
    clearInterval(sasTimerInterval);
    if (sasTimerEl)   sasTimerEl.textContent    = '00:00';
    if (sasTimerWrap) sasTimerWrap.style.display = 'block';
    if (sasStaticNote) sasStaticNote.style.display = 'none';
    downloadBtn.disabled = true;
    showError('Your download link has expired. Tap below to get a new link.', true);
  }

  // ── SAS countdown ─────────────────────────────────────────
  function startCountdown() {
    function tick() {
      const remaining = SAS_EXPIRY_MS - (Date.now() - downloadTime);
      if (remaining <= 0) { markExpired(); return; }

      // v2: only show countdown timer when under 10 minutes
      if (remaining <= SHOW_TIMER_MS) {
        if (sasStaticNote) sasStaticNote.style.display = 'none';
        if (sasTimerWrap)  sasTimerWrap.style.display  = 'block';
        if (sasTimerEl) {
          sasTimerEl.textContent = formatCountdown(remaining);
          sasTimerEl.style.color = remaining < 3 * 60 * 1000 ? 'var(--error)' : 'var(--text)';
        }
      } else {
        // Still plenty of time — show static reassuring message
        if (sasStaticNote) sasStaticNote.style.display = 'block';
        if (sasTimerWrap)  sasTimerWrap.style.display  = 'none';
      }
    }
    tick();
    sasTimerInterval = setInterval(tick, 1000);
  }

  // ── Download ──────────────────────────────────────────────
  function triggerDownload(url) {
    const a = document.createElement('a');
    a.href     = url;
    a.download = 'health-intake-form.pdf';
    a.rel      = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  downloadBtn.addEventListener('click', () => {
    if (!downloadUrl) {
      showError('Download link is not available. Please speak to clinic staff.');
      return;
    }
    if (Date.now() - downloadTime >= SAS_EXPIRY_MS) { markExpired(); return; }
    if (!navigator.onLine) {
      showError('Download failed. Please check your connection and try again.');
      return;
    }
    hideError();
    triggerDownload(downloadUrl);
  });

  // ── Refresh SAS ───────────────────────────────────────────
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled    = true;
    refreshBtn.textContent = 'Getting new link…';
    hideError();

    try {
      const response = await fetch(
        `${API_BASE}/api/status/${encodeURIComponent(submissionId)}?email=${encodeURIComponent(patientEmail)}`,
        { headers: { 'Cache-Control': 'no-cache' } }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.status === 'completed' && data.downloadUrl) {
        downloadUrl  = data.downloadUrl;
        downloadTime = Date.now();
        sessionStorage.setItem('mvfhis_download_url',  downloadUrl);
        sessionStorage.setItem('mvfhis_download_time', downloadTime.toString());
        downloadBtn.disabled     = false;
        refreshBtn.style.display = 'none';
        clearInterval(sasTimerInterval);
        startCountdown();
        triggerDownload(downloadUrl);
      } else {
        throw new Error('Not ready');
      }
    } catch (err) {
      showError('Could not get a new link. Please speak to clinic staff.', true);
    } finally {
      refreshBtn.disabled    = false;
      refreshBtn.textContent = 'Get a New Link';
    }
  });

  // ── Init ──────────────────────────────────────────────────
  if (!downloadUrl || !downloadTime) {
    showError('Your form could not be loaded. Please speak to clinic staff.');
    downloadBtn.disabled = true;
    return;
  }
  if (Date.now() - downloadTime >= SAS_EXPIRY_MS) { markExpired(); return; }

  startCountdown();
});
