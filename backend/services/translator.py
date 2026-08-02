"""
backend/services/translator.py
Azure Cognitive Services — Translator

Translates text to English (or any target language).
Uses the Azure Translator REST API directly (simpler than SDK for this use case).
"""

import os
import logging
import requests

log = logging.getLogger(__name__)

TRANSLATOR_KEY      = os.environ.get('TRANSLATOR_KEY')
TRANSLATOR_ENDPOINT = os.environ.get(
    'TRANSLATOR_ENDPOINT',
    'https://api.cognitive.microsofttranslator.com'
)
TRANSLATOR_REGION   = os.environ.get('TRANSLATOR_REGION', 'canadacentral')


def translate_text(text: str, target: str = 'en') -> str:
    """
    Translate a single string to the target language.

    Args:
        text:   Text to translate
        target: Target language code e.g. 'en', 'fr', 'es'

    Returns:
        Translated string

    Raises:
        RuntimeError: if translation fails
    """
    if not text or not text.strip():
        return text

    if not TRANSLATOR_KEY:
        raise RuntimeError('TRANSLATOR_KEY not configured')

    results = _call_translator([text], target)
    return results[0] if results else text


def translate_batch(texts: list, target: str = 'en') -> list:
    """
    Translate a list of strings to the target language in one API call.
    More efficient than calling translate_text repeatedly.

    Args:
        texts:  List of strings to translate
        target: Target language code

    Returns:
        List of translated strings (same order as input)
    """
    if not texts:
        return []

    if not TRANSLATOR_KEY:
        log.warning('[translator] No key configured — returning originals')
        return texts

    return _call_translator(texts, target)


def _call_translator(texts: list, target: str) -> list:
    """
    Internal — calls Azure Translator REST API.
    Handles batching and response parsing.
    """
    url     = f'{TRANSLATOR_ENDPOINT}/translate'
    headers = {
        'Ocp-Apim-Subscription-Key':    TRANSLATOR_KEY,
        'Ocp-Apim-Subscription-Region': TRANSLATOR_REGION,
        'Content-Type':                 'application/json',
    }
    params = {
        'api-version': '3.0',
        'to':          target,
    }
    body = [{'text': t} for t in texts]

    try:
        response = requests.post(url, headers=headers, params=params, json=body, timeout=10)
        response.raise_for_status()
        data = response.json()

        results = []
        for item in data:
            translated = item['translations'][0]['text'] if item.get('translations') else ''
            results.append(translated)

        log.info(f'[translator] Translated {len(texts)} strings → {target}')
        return results

    except requests.RequestException as e:
        log.error(f'[translator] API error: {e}')
        raise RuntimeError(f'Translation failed: {e}')
