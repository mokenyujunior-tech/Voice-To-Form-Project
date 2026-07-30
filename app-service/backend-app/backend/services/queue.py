"""
backend/services/queue.py
Azure Storage Queue — Managed Identity edition

App Service drops one message per submission onto voiceform-queue after it has
uploaded the temp PDF. The Function App picks it up, runs Document
Intelligence, writes the final PDF, and updates the submissions table.

Queue lives in the FUNCTION storage account (stfuncvoiceformcac).
Auth via Managed Identity — no keys.

Message payload (JSON):
  {
    "submission_id": "<uuid>",
    "patient_email": "<email>",
    "blob_path":     "temp-intake/{submission_id}-temp.pdf",
    "language":      "<BCP-47>"
  }
"""

import os
import json
import base64
import logging

from azure.identity import DefaultAzureCredential
from azure.storage.queue import QueueClient

log = logging.getLogger(__name__)

FUNC_ACCOUNT = os.environ.get('FUNC_STORAGE_ACCOUNT', 'stfuncvoiceformcac')
QUEUE_NAME   = os.environ.get('AZURE_QUEUE_NAME', 'voiceform-queue')

_credential = DefaultAzureCredential()


def enqueue_job(message: str) -> None:
    """
    Drop a JSON job message onto voiceform-queue.

    Azure Functions' queue trigger expects base64-encoded messages by default,
    so we encode here to match what the Function App decodes.
    """
    try:
        endpoint = f'https://{FUNC_ACCOUNT}.queue.core.windows.net/{QUEUE_NAME}'
        client   = QueueClient.from_queue_url(queue_url=endpoint, credential=_credential)

        encoded = base64.b64encode(message.encode('utf-8')).decode('utf-8')
        client.send_message(encoded)

        log.info(f'[queue] message enqueued to {QUEUE_NAME}')
    except Exception as e:
        log.error(f'[queue] enqueue failed: {e}')
        raise RuntimeError(f'Queue error: {e}')
