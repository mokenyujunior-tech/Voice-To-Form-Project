"""
backend/services/table.py
Azure Table Storage — Managed Identity edition

Tracks submission status. Per team spec:
  PartitionKey = patient email
  RowKey       = submissionId
  status       = 'processing' | 'completed' | 'failed'
  blobPath     = 'pdfs/{submissionId}-final.pdf'  (written by the Function App)

The 'submissions' table lives in the FUNCTION storage account
(stfuncvoiceformcac). Auth is via the App Service Managed Identity — no keys.

Note on the flow: App Service writes the initial 'processing' row. The
Function App later flips it to 'completed' and fills in blobPath after it
generates the final PDF. App Service's /api/status endpoint reads this row.
"""

import os
import logging
from datetime import datetime, timezone

from azure.identity import DefaultAzureCredential
from azure.data.tables import TableServiceClient, UpdateMode

log = logging.getLogger(__name__)

FUNC_ACCOUNT = os.environ.get('FUNC_STORAGE_ACCOUNT', 'stfuncvoiceformcac')
TABLE_NAME   = os.environ.get('AZURE_TABLE_NAME', 'submissions')

_credential = DefaultAzureCredential()


def _table_client():
    endpoint = f'https://{FUNC_ACCOUNT}.table.core.windows.net'
    service  = TableServiceClient(endpoint=endpoint, credential=_credential)
    try:
        service.create_table_if_not_exists(TABLE_NAME)
    except Exception:
        pass
    return service.get_table_client(TABLE_NAME)


def upsert_submission(patient_email: str, submission_id: str, data: dict) -> None:
    """
    Create or update a submission record.

    Args:
        patient_email: PartitionKey
        submission_id: RowKey
        data:          extra fields (status, language, blobPath, etc.)
    """
    try:
        client = _table_client()
        entity = {
            'PartitionKey': patient_email,
            'RowKey':       submission_id,
            **data,
            'updated_at':   datetime.now(timezone.utc).isoformat(),
        }
        client.upsert_entity(entity=entity, mode=UpdateMode.MERGE)
        log.info(f'[table] upserted {submission_id} (pk={patient_email}) '
                 f'status={data.get("status")}')
    except Exception as e:
        log.error(f'[table] upsert failed for {submission_id}: {e}')
        raise


def get_submission(patient_email: str, submission_id: str) -> dict | None:
    """
    Retrieve a submission record by email + submissionId.

    Returns the entity dict, or None if not found.
    """
    try:
        client = _table_client()
        entity = client.get_entity(partition_key=patient_email, row_key=submission_id)
        return dict(entity)
    except Exception as e:
        log.warning(f'[table] {submission_id} (pk={patient_email}) not found: {e}')
        return None
