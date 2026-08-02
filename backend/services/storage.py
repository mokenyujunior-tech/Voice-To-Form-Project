"""
backend/services/storage.py
Azure Blob Storage — Managed Identity edition

Two jobs:
  1. upload_temp_pdf()   — App Service uploads the rough/temp PDF to the
                            temp-intake container so the Function App can pick
                            it up, run Document Intelligence, and produce the
                            final PDF.
  2. generate_sas_url()  — Once the Function App has written the FINAL PDF to
                            the 'pdfs' container and marked the submission
                            'completed', App Service mints a short-lived,
                            read-only User Delegation SAS URL for the patient.

Auth: NO account keys anywhere. Uses the App Service's system-assigned
Managed Identity via DefaultAzureCredential. The identity has:
  - Storage Blob Data Contributor  (read/write blobs)
  - Storage Blob Delegator         (sign User Delegation SAS)
on the storage accounts.

Resource layout (per team spec):
  - temp-intake  container lives in the FUNCTION storage account (stfuncvoiceformcac)
  - pdfs         container lives in the DATA storage account     (stvoiceformcac)
"""

import os
import logging
from datetime import datetime, timedelta, timezone

from azure.identity import DefaultAzureCredential
from azure.storage.blob import (
    BlobServiceClient,
    BlobSasPermissions,
    generate_blob_sas,
    ContentSettings,
)

log = logging.getLogger(__name__)

# ── Storage account names (NOT connection strings — MI auth) ──
# Data account: holds the final 'pdfs' container + is where SAS is minted
DATA_ACCOUNT  = os.environ.get('DATA_STORAGE_ACCOUNT',  'stvoiceformcac')
# Function-runtime account: holds temp-intake, submissions table, the queue
FUNC_ACCOUNT  = os.environ.get('FUNC_STORAGE_ACCOUNT',  'stfuncvoiceformcac')

TEMP_CONTAINER  = os.environ.get('TEMP_BLOB_CONTAINER',  'temp-intake')
FINAL_CONTAINER = os.environ.get('FINAL_BLOB_CONTAINER', 'pdfs')

SAS_EXPIRY_MINUTES = int(os.environ.get('SAS_EXPIRY_MINUTES', '30'))

# One shared credential for the whole process. DefaultAzureCredential picks up
# the App Service's system-assigned Managed Identity automatically in Azure.
_credential = DefaultAzureCredential()


def _account_url(account_name: str) -> str:
    return f'https://{account_name}.blob.core.windows.net'


def _blob_service(account_name: str) -> BlobServiceClient:
    return BlobServiceClient(account_url=_account_url(account_name), credential=_credential)


# ── Upload temp PDF (App Service → temp-intake) ──────────────
def upload_temp_pdf(submission_id: str, pdf_bytes: bytes) -> str:
    """
    Upload the rough/temp PDF to the temp-intake container so the Function App
    can process it. Returns the blob path the Function App will read from.

    The temp blob is named by submission_id so it's easy to correlate.
    Path convention: temp-intake/{submission_id}.pdf
    """
    blob_name = f'{submission_id}.pdf'

    try:
        service = _blob_service(FUNC_ACCOUNT)
        blob = service.get_container_client(TEMP_CONTAINER).get_blob_client(blob_name)
        blob.upload_blob(
            pdf_bytes,
            overwrite=True,
            content_settings=ContentSettings(content_type='application/pdf'),
        )
        log.info(f'[storage] temp PDF uploaded → {TEMP_CONTAINER}/{blob_name}')
        return f'{TEMP_CONTAINER}/{blob_name}'
    except Exception as e:
        log.error(f'[storage] temp PDF upload failed for {submission_id}: {e}')
        raise RuntimeError(f'Could not upload temp PDF: {e}')


# ── Generate User Delegation SAS (for the FINAL pdf) ─────────
def generate_sas_url(blob_path: str) -> str:
    """
    Generate a read-only User Delegation SAS URL for the final PDF.

    blob_path is what the Function App wrote into the submissions table,
    formatted (per spec) as:  pdfs/{submissionId}-final.pdf

    User Delegation SAS is signed with a key obtained from Azure AD via the
    Managed Identity — NOT an account key. Requires the Storage Blob Delegator
    role on the data account.
    """
    # Split 'pdfs/{id}-final.pdf' → container='pdfs', blob='{id}-final.pdf'
    if '/' in blob_path:
        container_name, blob_name = blob_path.split('/', 1)
    else:
        container_name, blob_name = FINAL_CONTAINER, blob_path

    try:
        service = _blob_service(DATA_ACCOUNT)

        # Request a user delegation key valid for the SAS lifetime
        start  = datetime.now(timezone.utc) - timedelta(minutes=5)  # small clock skew buffer
        expiry = datetime.now(timezone.utc) + timedelta(minutes=SAS_EXPIRY_MINUTES)

        delegation_key = service.get_user_delegation_key(
            key_start_time=start,
            key_expiry_time=expiry,
        )

        sas_token = generate_blob_sas(
            account_name=DATA_ACCOUNT,
            container_name=container_name,
            blob_name=blob_name,
            user_delegation_key=delegation_key,
            permission=BlobSasPermissions(read=True),   # read-only
            expiry=expiry,
            start=start,
            protocol='https',                            # HTTPS only
        )

        url = f'{_account_url(DATA_ACCOUNT)}/{container_name}/{blob_name}?{sas_token}'
        log.info(f'[storage] User Delegation SAS minted for {blob_path} '
                 f'(expires {expiry.isoformat()})')
        return url

    except Exception as e:
        log.error(f'[storage] SAS generation failed for {blob_path}: {e}')
        raise RuntimeError(f'Could not generate download link: {e}')
