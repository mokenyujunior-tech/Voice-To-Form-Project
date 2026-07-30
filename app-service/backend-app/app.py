"""
app.py — MVFHIS Flask Backend (v2 — field-by-field, Managed Identity)
Multilingual Voice-to-Form Health Intake System

Flow (per team spec "What to tell Esther"):
  1. Browser records 12 fields one at a time, holds them in memory as WAV.
  2. On Submit, browser POSTs all 12 labelled WAV clips in ONE request.
  3. App Service (this file):
       - transcribes each clip (Speech) + translates to English (Translator)
       - assembles the 12 English answers
       - builds a TEMP PDF in memory (ReportLab)
       - uploads temp PDF → temp-intake  (Managed Identity)
       - writes 'processing' row → submissions table (pk=email, rk=submissionId)
       - drops a queue message → voiceform-queue
       - returns 202 { submissionId }
  4. Browser polls /api/status/<submissionId> (needs email too).
  5. Function App (teammate) turns temp PDF → final PDF via Document
     Intelligence, writes 'pdfs/{submissionId}-final.pdf', flips row to
     'completed' with blobPath.
  6. /api/status sees 'completed', mints a User Delegation SAS, returns the URL.

Auth: Managed Identity for Storage (blob/queue/table). Speech + Translator
use their keys. No account keys anywhere.
"""

import os
import uuid
import json
import logging
from datetime import datetime, timezone

from flask import Flask, request, jsonify, send_from_directory
from dotenv import load_dotenv

from backend.services.speech     import transcribe_audio
from backend.services.translator import translate_text
from backend.services.queue      import enqueue_job
from backend.services.storage    import upload_temp_pdf, generate_sas_url
from backend.services.table      import get_submission, upsert_submission
from backend.services.pdf_builder import build_temp_pdf

load_dotenv()

app = Flask(__name__, static_folder='static', static_url_path='')
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# The 12 fields, in order. Keys match the labels the browser attaches to each
# audio clip. Labels drive both transcription order and PDF layout.
FIELDS = [
    ('patientName',           'Patient Name'),
    ('dateOfBirth',           'Date of Birth'),
    ('gender',                'Gender'),
    ('address',               'Address'),
    ('phoneNumber',           'Phone Number'),
    ('email',                 'Email'),
    ('symptoms',              'Symptoms'),
    ('medicalHistory',        'Medical History'),
    ('currentMedications',    'Current Medications'),
    ('allergies',             'Allergies'),
    ('emergencyContactName',  'Emergency Contact Name'),
    ('emergencyContactPhone', 'Emergency Contact Phone'),
]


# ── Serve frontend ────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.errorhandler(404)
def not_found(e):
    return send_from_directory(app.static_folder, 'index.html')


# ── POST /api/submit ──────────────────────────────────────────
@app.route('/api/submit', methods=['POST'])
def submit():
    """
    Receive 12 labelled WAV clips in one multipart request.

    multipart/form-data:
      language_code                 — BCP-47, e.g. 'fr-FR'
      patientName                   — WAV file
      dateOfBirth                   — WAV file
      ... (all 12 field keys) ...

    Returns 202 { submissionId }.
    """
    language_code = request.form.get('language_code', 'en-CA')

    # Require all 12 audio fields
    missing = [key for key, _ in FIELDS if key not in request.files]
    if missing:
        return jsonify(error=f'Missing audio for: {", ".join(missing)}'), 400

    submission_id = str(uuid.uuid4())
    submitted_at  = datetime.now(timezone.utc).isoformat()

    # ── Transcribe + translate each field ───────────────────
    english_answers = {}   # label -> English text
    patient_email   = None

    for key, label in FIELDS:
        audio_bytes = request.files[key].read()

        if not audio_bytes:
            english_answers[label] = ''
            continue

        # 1) transcribe in patient's language
        try:
            transcription = transcribe_audio(audio_bytes, language_code)
        except Exception as e:
            log.error(f'[submit] transcription failed on {key} for {submission_id}: {e}')
            return jsonify(error='Could not understand one of the recordings. '
                                 'Please try again.'), 500

        # 2) translate to English (skip if already English or empty)
        if not transcription:
            english_answers[label] = ''
        elif language_code.startswith('en'):
            english_answers[label] = transcription
        else:
            try:
                english_answers[label] = translate_text(transcription, target='en')
            except Exception as e:
                log.error(f'[submit] translation failed on {key} for {submission_id}: {e}')
                return jsonify(error='Translation service is unavailable. '
                                     'Please try again.'), 500

        # Capture the patient's spoken email for use as the Table PartitionKey
        if key == 'email' and english_answers[label]:
            patient_email = _normalize_email(english_answers[label])

    # Fall back to Easy Auth email if the spoken email is unusable as a key
    if not patient_email:
        patient_email = _get_auth_email()

    log.info(f'[submit] id={submission_id} email={patient_email} '
             f'fields={len(english_answers)}')

    # ── Build the temp PDF ──────────────────────────────────
    try:
        pdf_bytes = build_temp_pdf(
            submission_id=submission_id,
            language_code=language_code,
            submitted_at=submitted_at,
            answers=english_answers,   # ordered dict-ish (Python 3.7+ preserves insertion)
            field_order=[label for _, label in FIELDS],
        )
    except Exception as e:
        log.error(f'[submit] temp PDF build failed for {submission_id}: {e}')
        return jsonify(error='Could not assemble your form. Please try again.'), 500

    # ── Upload temp PDF → temp-intake ───────────────────────
    try:
        blob_path = upload_temp_pdf(submission_id, pdf_bytes)
    except Exception as e:
        log.error(f'[submit] temp upload failed for {submission_id}: {e}')
        return jsonify(error='Could not save your form. Please try again.'), 500

    # ── Write initial 'processing' row ──────────────────────
    upsert_submission(patient_email, submission_id, {
        'status':       'processing',
        'language':     language_code,
        'submitted_at': submitted_at,
        'temp_blob':    blob_path,
    })

    # ── Enqueue for the Function App ────────────────────────
    job = {
        'submission_id': submission_id,
        'patient_email': patient_email,
        'blob_path':     blob_path,          # temp-intake/{id}-temp.pdf
        'language':      language_code,
    }
    try:
        enqueue_job(json.dumps(job))
    except Exception as e:
        log.error(f'[submit] enqueue failed for {submission_id}: {e}')
        upsert_submission(patient_email, submission_id, {'status': 'failed'})
        return jsonify(error='Could not start form generation. Please try again.'), 500

    # Browser needs both submissionId AND email to poll (email is the PartitionKey)
    return jsonify(submissionId=submission_id, patientEmail=patient_email), 202


# ── GET /api/status/<submission_id> ──────────────────────────
@app.route('/api/status/<submission_id>', methods=['GET'])
def status(submission_id):
    """
    Poll for completion. Needs the patient email as a query param since it's
    the Table PartitionKey:  /api/status/<id>?email=<email>

    Responses:
      { "status": "processing" }
      { "status": "completed", "downloadUrl": "https://...SAS..." }
      { "status": "failed" }
      404 if not found
    """
    patient_email = request.args.get('email', '')
    if not patient_email:
        return jsonify(error='email query parameter required'), 400

    record = get_submission(patient_email, submission_id)
    if not record:
        return jsonify(error='Submission not found'), 404

    record_status = record.get('status', 'processing')

    if record_status == 'completed':
        blob_path = record.get('blobPath') or record.get('blob_path', '')
        if not blob_path:
            log.warning(f'[status] {submission_id} completed but no blobPath yet')
            return jsonify(status='processing')
        try:
            download_url = generate_sas_url(blob_path)
            return jsonify(status='completed', downloadUrl=download_url)
        except Exception as e:
            log.error(f'[status] SAS failed for {submission_id}: {e}')
            return jsonify(error='Could not create download link.'), 500

    if record_status == 'failed':
        return jsonify(status='failed')

    return jsonify(status='processing')


# ── Helpers ───────────────────────────────────────────────────
def _normalize_email(spoken: str) -> str:
    """
    Patients speak their email, so STT returns things like
    'maria at gmail dot com'. Best-effort normalize to a usable key.
    Table PartitionKeys can't contain / \\ # ? so we also strip those.
    """
    s = spoken.strip().lower()
    s = s.replace(' at ', '@').replace(' dot ', '.')
    s = s.replace(' ', '')
    for bad in ['/', '\\', '#', '?', '\t', '\n']:
        s = s.replace(bad, '')
    return s or 'unknown@local.dev'


def _get_auth_email() -> str:
    """Easy Auth injects the signed-in user's email; fallback for local dev."""
    return request.headers.get('X-MS-CLIENT-PRINCIPAL-NAME', 'unknown@local.dev')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port,
            debug=os.environ.get('FLASK_DEBUG', 'false').lower() == 'true')
