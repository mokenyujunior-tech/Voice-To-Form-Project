/**
 * screen3.js — Field-by-field recording (v2 spec)
 *
 * 12 fields, recorded one at a time. Each recording is converted to WAV
 * (via window.WAV) and held in memory. On Submit, all 12 labelled WAV clips
 * are uploaded in ONE multipart request to /api/submit.
 */

document.addEventListener('DOMContentLoaded', () => {

  // 12 fields — keys MUST match the backend FIELDS list in app.py
  const FIELDS = [
    { key: 'patientName',           label: 'Patient Name',            prompt: 'Please say your full name.' },
    { key: 'dateOfBirth',           label: 'Date of Birth',           prompt: 'Please say your date of birth.' },
    { key: 'gender',                label: 'Gender',                  prompt: 'Please say your gender.' },
    { key: 'address',               label: 'Address',                 prompt: 'Please say your home address.' },
    { key: 'phoneNumber',           label: 'Phone Number',            prompt: 'Please say your phone number.' },
    { key: 'email',                 label: 'Email',                   prompt: 'Please say your email address.' },
    { key: 'symptoms',              label: 'Symptoms',                prompt: 'Please describe your symptoms.' },
    { key: 'medicalHistory',        label: 'Medical History',         prompt: 'Please describe your medical history.' },
    { key: 'currentMedications',    label: 'Current Medications',     prompt: 'Please list your current medications, or say none.' },
    { key: 'allergies',             label: 'Allergies',               prompt: 'Please list any allergies, or say none.' },
    { key: 'emergencyContactName',  label: 'Emergency Contact Name',  prompt: 'Please say your emergency contact\u2019s name.' },
    { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', prompt: 'Please say your emergency contact\u2019s phone number.' },
  ];
  const TOTAL = FIELDS.length;
  const MAX_SECONDS = 120;   // per-field cap

  // ── DOM ───────────────────────────────────────────────────
  const dotsEl        = document.getElementById('field-dots');
  const counterEl     = document.getElementById('field-counter');
  const fieldNumberEl = document.getElementById('field-number');
  const fieldLabelEl  = document.getElementById('field-label');
  const fieldPromptEl = document.getElementById('field-prompt');

  const recordBtn      = document.getElementById('record-btn');
  const recordBtnLabel = document.getElementById('record-btn-label');
  const stopBtn        = document.getElementById('stop-btn');
  const playBtn        = document.getElementById('play-btn');
  const rerecordBtn    = document.getElementById('rerecord-btn');
  const prevBtn        = document.getElementById('prev-btn');
  const nextBtn        = document.getElementById('next-btn');
  const submitBtn      = document.getElementById('submit-btn');
  const timerEl        = document.getElementById('record-timer');
  const waveform       = document.getElementById('waveform');
  const errorBanner    = document.getElementById('error-banner');
  const permissionBanner = document.getElementById('permission-banner');
  const confirmBanner  = document.getElementById('confirm-banner');

  const rrModal = document.getElementById('rerecord-confirm-modal');
  const rrYes   = document.getElementById('rerecord-confirm-yes');
  const rrNo    = document.getElementById('rerecord-confirm-no');

  // ── State ─────────────────────────────────────────────────
  const languageCode = sessionStorage.getItem('mvfhis_language_code') || 'en-CA';
  if (!sessionStorage.getItem('mvfhis_language_code')) {
    window.location.href = 'screen2-language.html';
    return;
  }

  let current = 0;
  const recordings = new Array(TOTAL).fill(null);  // WAV blobs, per field

  let mediaRecorder = null;
  let mediaStream   = null;
  let chunks        = [];
  let audioEl       = null;
  let timerInterval = null;
  let seconds       = 0;
  let isRecording   = false;
  let converting    = false;

  // ── Build dots ────────────────────────────────────────────
  FIELDS.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'field-dot';
    d.dataset.index = i;
    dotsEl.appendChild(d);
  });

  // ── Helpers ───────────────────────────────────────────────
  function showError(msg) { errorBanner.textContent = msg; errorBanner.classList.add('visible'); }
  function hideError() { errorBanner.classList.remove('visible'); }
  function showConfirm() { confirmBanner.classList.add('visible'); }
  function hideConfirm() { confirmBanner.classList.remove('visible'); }

  function fmt(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const x = (s % 60).toString().padStart(2, '0');
    return `${m}:${x}`;
  }

  function renderField() {
    const f = FIELDS[current];
    fieldNumberEl.textContent = `Field ${current + 1} of ${TOTAL}`;
    fieldLabelEl.textContent  = f.label;
    fieldPromptEl.textContent = f.prompt;
    counterEl.textContent     = `${current + 1} / ${TOTAL}`;

    // dots
    Array.from(dotsEl.children).forEach((d, i) => {
      d.classList.toggle('done', !!recordings[i]);
      d.classList.toggle('active', i === current);
    });

    // reset per-field UI
    timerEl.textContent = '00:00';
    seconds = 0;
    hideError();
    hideConfirm();
    permissionBanner.classList.remove('visible');
    waveform.classList.remove('active');
    recordBtn.classList.remove('recording');

    const hasRec = !!recordings[current];
    recordBtnLabel.textContent = hasRec ? 'Recorded' : 'Tap to Record';
    recordBtn.disabled = hasRec;
    stopBtn.disabled = true;
    playBtn.disabled = !hasRec;
    rerecordBtn.disabled = !hasRec;

    // nav
    prevBtn.disabled = current === 0;
    updateNextSubmit();
  }

  function updateNextSubmit() {
    const hasRec = !!recordings[current];
    const allDone = recordings.every(r => !!r);
    const isLast = current === TOTAL - 1;

    // Next enabled only when this field is recorded and not on last field
    nextBtn.disabled = !hasRec || isLast;
    nextBtn.style.display = isLast ? 'none' : '';

    // Submit shows on last field, enabled only when ALL recorded
    submitBtn.style.display = isLast ? 'block' : 'none';
    submitBtn.disabled = !allDone || converting;
  }

  // ── Recording ─────────────────────────────────────────────
  async function startRecording() {
    hideError(); hideConfirm();
    chunks = [];
    seconds = 0;
    timerEl.textContent = '00:00';

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        permissionBanner.classList.add('visible');
      } else {
        showError('Could not access your microphone. Please try again.');
      }
      return;
    }

    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    }
    try {
      mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType })
                               : new MediaRecorder(mediaStream);
    } catch (err) {
      showError('Recording is not supported on this browser.');
      stopStream();
      return;
    }

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStopped;

    mediaRecorder.start();
    isRecording = true;
    recordBtn.classList.add('recording');
    recordBtnLabel.textContent = 'Recording…';
    waveform.classList.add('active');
    stopBtn.disabled = false;
    playBtn.disabled = true;
    rerecordBtn.disabled = true;

    timerInterval = setInterval(() => {
      seconds++;
      timerEl.textContent = fmt(seconds);
      if (seconds >= MAX_SECONDS) stopRecording();
    }, 1000);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    clearInterval(timerInterval);
    isRecording = false;
  }

  async function onRecordingStopped() {
    stopStream();
    waveform.classList.remove('active');
    recordBtn.classList.remove('recording');

    const raw = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });

    // Convert to WAV before storing (Azure Speech needs WAV)
    converting = true;
    recordBtnLabel.textContent = 'Processing…';
    stopBtn.disabled = true;
    try {
      const wav = await window.WAV.fromBlob(raw);
      recordings[current] = wav;
      recordBtnLabel.textContent = 'Recorded';
      showConfirm();
    } catch (err) {
      console.error('[wav]', err);
      showError('Could not process the recording. Please re-record.');
      recordings[current] = null;
      recordBtnLabel.textContent = 'Tap to Record';
      recordBtn.disabled = false;
    } finally {
      converting = false;
      playBtn.disabled = !recordings[current];
      rerecordBtn.disabled = !recordings[current];
      recordBtn.disabled = !!recordings[current];
      updateNextSubmit();
    }
  }

  function stopStream() {
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  }

  function playBack() {
    const wav = recordings[current];
    if (!wav) return;
    if (audioEl) { audioEl.pause(); audioEl = null; }
    audioEl = new Audio(URL.createObjectURL(wav));
    audioEl.play().catch(() => showError('Could not play back the recording.'));
  }

  // ── Re-record ─────────────────────────────────────────────
  function openRr() { rrModal.classList.add('visible'); }
  function closeRr() { rrModal.classList.remove('visible'); }
  function confirmRr() {
    closeRr();
    recordings[current] = null;
    renderField();
  }

  // ── Navigation ────────────────────────────────────────────
  function goPrev() { if (current > 0) { current--; renderField(); } }
  function goNext() { if (current < TOTAL - 1 && recordings[current]) { current++; renderField(); } }

  // ── Submit all ────────────────────────────────────────────
  async function submitAll() {
    if (!recordings.every(r => !!r)) {
      showError('Please record all fields before submitting.');
      return;
    }
    if (!navigator.onLine) {
      showError('Connection lost. Please check your internet and try again.');
      return;
    }

    hideError();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const form = new FormData();
    form.append('language_code', languageCode);
    FIELDS.forEach((f, i) => {
      form.append(f.key, recordings[i], `${f.key}.wav`);
    });

    try {
      const res = await fetch('/api/submit', { method: 'POST', body: form });

      if (res.status === 401) { window.location.href = '/.auth/login/aad'; return; }
      if (res.status !== 202 && !res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data.submissionId) throw new Error('No submissionId returned');

      sessionStorage.setItem('mvfhis_submission_id', data.submissionId);
      // email is the Table PartitionKey — screen4 needs it to poll
      sessionStorage.setItem('mvfhis_patient_email', data.patientEmail || '');
      window.location.href = 'screen4-processing.html';

    } catch (err) {
      console.error('[submit]', err);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit All Answers';
      showError(!navigator.onLine
        ? 'Connection lost. Please check your internet and try again.'
        : 'Something went wrong submitting your answers. Please try again.');
    }
  }

  // ── Wire up ───────────────────────────────────────────────
  recordBtn.addEventListener('click', () => { if (!isRecording && !recordings[current] && !converting) startRecording(); });
  stopBtn.addEventListener('click', stopRecording);
  playBtn.addEventListener('click', playBack);
  rerecordBtn.addEventListener('click', openRr);
  rrYes.addEventListener('click', confirmRr);
  rrNo.addEventListener('click', closeRr);
  prevBtn.addEventListener('click', goPrev);
  nextBtn.addEventListener('click', goNext);
  submitBtn.addEventListener('click', submitAll);

  // ── Init ──────────────────────────────────────────────────
  renderField();
});
