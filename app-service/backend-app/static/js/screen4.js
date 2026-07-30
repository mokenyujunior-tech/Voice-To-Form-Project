/**
 * screen4.js — Processing / Polling (v2)
 *
 * Polls GET /api/status/<submissionId>?email=<email> every 5s.
 * The email is the Table PartitionKey, so it must be sent with each poll.
 * When status flips to 'completed', stores the SAS URL and goes to download.
 *
 * Pauses the 15-min inactivity timer while polling so patients aren't logged
 * out mid-processing (the 40-min absolute timer still runs).
 */

document.addEventListener('DOMContentLoaded', () => {
  const errorBanner = document.getElementById('error-banner');
  const retryBtn    = document.getElementById('retry-btn');
  const stages      = document.querySelectorAll('.stage-item');

  const POLL_INTERVAL = 5000;
  const WARN_MS       = 5 * 60 * 1000;
  const MAX_RETRIES   = 60;
  const STAGE_AT      = [0, 3, 7, 12];

  const submissionId = sessionStorage.getItem('mvfhis_submission_id');
  const patientEmail = sessionStorage.getItem('mvfhis_patient_email') || '';

  let pollTimer = null;
  let startTime = Date.now();
  let pollCount = 0;
  let warnShown = false;

  if (typeof SESSION !== 'undefined') SESSION.pauseInactivity();

  function advanceStages() {
    stages.forEach((stage, i) => {
      if (pollCount > STAGE_AT[i] + 2) { stage.classList.remove('active'); stage.classList.add('done'); }
      else if (pollCount >= STAGE_AT[i]) { stage.classList.add('active'); stage.classList.remove('done'); }
    });
  }

  function showError(msg, showRetry = true) {
    errorBanner.textContent = msg;
    errorBanner.classList.add('visible');
    if (showRetry && retryBtn) retryBtn.style.display = 'flex';
    stopPolling();
    if (typeof SESSION !== 'undefined') SESSION.resumeInactivity();
  }

  function hideError() {
    errorBanner.classList.remove('visible');
    if (retryBtn) retryBtn.style.display = 'none';
  }

  async function poll() {
    if (!navigator.onLine) return;
    pollCount++;
    advanceStages();

    if (!warnShown && Date.now() - startTime > WARN_MS) {
      warnShown = true;
      errorBanner.textContent = 'This is taking longer than expected. Your form is still being processed. Please wait.';
      errorBanner.classList.add('visible');
      if (retryBtn) retryBtn.style.display = 'none';
    }

    if (pollCount > MAX_RETRIES) {
      showError('We were unable to process your form. Please speak to clinic staff for assistance.', false);
      return;
    }

    try {
      const url = `/api/status/${encodeURIComponent(submissionId)}?email=${encodeURIComponent(patientEmail)}`;
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });

      if (res.status === 401) { window.location.href = '/.auth/login/aad'; return; }
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (data.status === 'completed' && data.downloadUrl) {
        stopPolling();
        sessionStorage.setItem('mvfhis_download_url',  data.downloadUrl);
        sessionStorage.setItem('mvfhis_download_time', Date.now().toString());
        if (typeof SESSION !== 'undefined') SESSION.resumeInactivity();
        window.location.href = 'screen5-download.html';
      } else if (data.status === 'failed') {
        showError('We were unable to process your form. Please speak to clinic staff.', false);
      }
      // else keep polling
    } catch (err) {
      console.warn('[poll]', err.message);
    }
  }

  function startPolling() {
    hideError();
    warnShown = false;
    if (typeof SESSION !== 'undefined') SESSION.pauseInactivity();
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  window.addEventListener('online', () => { if (!pollTimer) startPolling(); });
  if (retryBtn) retryBtn.addEventListener('click', () => { pollCount = 0; startTime = Date.now(); startPolling(); });

  if (!submissionId) {
    showError('We could not find your submission. Please go back and try again.', false);
    return;
  }

  startPolling();
});
