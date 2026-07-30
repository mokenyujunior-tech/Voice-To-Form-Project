"""
backend/services/speech.py
Azure Speech Service — Speech-to-Text (per-field)

Transcribes ONE field's audio recording in the patient's language.
Called once per field (12 times per submission).

IMPORTANT — AUDIO FORMAT:
  The Azure Speech SDK's file input (AudioConfig(filename=...)) only accepts
  WAV/PCM (16 kHz, 16-bit, mono). It does NOT read webm/opus and will throw
  0xa (SPXERR_INVALID_HEADER) if given one.

  => The BROWSER must convert each recording to WAV before upload.
     See static/js/screen3.js (recordFieldAsWav / encodeWav).

  If you ever switch the frontend back to sending webm, this will break again
  with SPXERR_INVALID_HEADER. Keep the browser-side WAV conversion in place.

AUTH:
  Speech uses its subscription key (SPEECH_KEY). Unlike Blob/Table/Queue,
  the Speech SDK's simplest path is key-based, and the team's Managed Identity
  roles cover Storage, not Speech. Key stays in App Settings (or Key Vault).
"""

import os
import tempfile
import logging

import azure.cognitiveservices.speech as speechsdk

log = logging.getLogger(__name__)

SPEECH_KEY    = os.environ.get('SPEECH_KEY')
SPEECH_REGION = os.environ.get('SPEECH_REGION', 'canadacentral')


def transcribe_audio(audio_bytes: bytes, language_code: str) -> str:
    """
    Transcribe one field's audio (WAV/PCM bytes) to text.

    Args:
        audio_bytes:   WAV audio (16 kHz mono 16-bit PCM) from the browser
        language_code: BCP-47 code e.g. 'fr-FR', 'es-ES', 'en-CA'

    Returns:
        Transcribed text (patient's language). Empty string if no speech
        detected — a patient may legitimately skip a field (e.g. "no allergies"
        spoken as silence), so we return '' rather than raising on NoMatch.

    Raises:
        RuntimeError: on hard failures (bad key, cancelled, invalid header)
    """
    if not SPEECH_KEY:
        raise RuntimeError('SPEECH_KEY not configured')

    # Write WAV bytes to a temp file for AudioConfig(filename=...)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
        speech_config.speech_recognition_language = language_code

        audio_config = speechsdk.audio.AudioConfig(filename=tmp_path)
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config,
            audio_config=audio_config,
        )

        result = recognizer.recognize_once_async().get()

        if result.reason == speechsdk.ResultReason.RecognizedSpeech:
            text = result.text.strip()
            log.info(f'[speech] recognized ({language_code}): "{text[:60]}"')
            return text

        elif result.reason == speechsdk.ResultReason.NoMatch:
            # No speech — treat as an empty answer, not a hard error
            log.warning(f'[speech] no speech detected ({language_code})')
            return ''

        elif result.reason == speechsdk.ResultReason.Canceled:
            details = result.cancellation_details
            log.error(f'[speech] canceled: {details.reason} — {details.error_details}')
            raise RuntimeError(f'Speech recognition cancelled: {details.error_details}')

        else:
            raise RuntimeError(f'Unexpected result reason: {result.reason}')

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
