# MVFHIS Backend v2 — Deployment Guide

App Service side of the Multilingual Voice-to-Form Health Intake System.
Field-by-field recording (12 fields), Managed Identity auth, builds the TEMP
PDF. The Function App (teammate's) turns the temp PDF into the final one.

Target App Service: `app-voiceform-cac1`

---

## What changed from v1

- **12 fields, recorded one at a time** (was: single freeform recording)
- **Managed Identity** for all Storage access (was: account keys)
- **Two storage accounts**: data (`stvoiceformcac`) + function runtime (`stfuncvoiceformcac`)
- **Table keys**: PartitionKey = patient email, RowKey = submissionId
- **Browser converts each clip to WAV** before upload (fixes the Speech SDK
  `SPXERR_INVALID_HEADER` issue — see `static/js/wav-encoder.js`)
- **App Service builds only the TEMP PDF** → temp-intake. Function App builds
  the final PDF via Document Intelligence.

---

## Required App Settings on `app-voiceform-cac1`

Managed Identity means NO storage keys/connection strings. Set these:

| Name | Value | Notes |
|---|---|---|
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | Oryx rebuild on deploy |
| `ENABLE_ORYX_BUILD` | `true` | |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `1800` | 30-min boot allowance |
| `PYTHON_VERSION` | `3.11` | |
| `SPEECH_KEY` | (from `spch-voiceform-cac`) | Speech uses a key |
| `SPEECH_REGION` | `canadacentral` | |
| `TRANSLATOR_KEY` | (from `trsl-voiceform-cac`) | Translator uses a key |
| `TRANSLATOR_REGION` | `canadacentral` | |
| `DATA_STORAGE_ACCOUNT` | `stvoiceformcac` | Holds final `pdfs` container |
| `FUNC_STORAGE_ACCOUNT` | `stfuncvoiceformcac` | Holds temp-intake, table, queue |
| `TEMP_BLOB_CONTAINER` | `temp-intake` | |
| `FINAL_BLOB_CONTAINER` | `pdfs` | |
| `AZURE_TABLE_NAME` | `submissions` | |
| `AZURE_QUEUE_NAME` | `voiceform-queue` | |
| `SAS_EXPIRY_MINUTES` | `30` | Download link lifetime |

**No `AZURE_STORAGE_*` keys or connection strings.** If any linger from v1,
delete them — the code no longer reads them and they can cause confusion.

### Managed Identity prerequisites (already done per teammate)

- System-assigned Managed Identity **enabled** on `app-voiceform-cac1`
- Role **Storage Blob Data Contributor** on `stvoiceformcac` AND `stfuncvoiceformcac`
- Role **Storage Blob Delegator** on `stvoiceformcac` (for User Delegation SAS)
- Role **Storage Queue Data Contributor** on `stfuncvoiceformcac` (to enqueue)
- Role **Storage Table Data Contributor** on `stfuncvoiceformcac` (to read/write status)

If queue/table access fails with 403, the last two roles are the likely gap —
`Blob Data Contributor` alone does NOT cover queues or tables.

---

## Deploy

### 1. Clear the package cache (avoids stale-wheel issues)

Kudu console → https://app-voiceform-cac1.scm.azurewebsites.net/DebugConsole
```bash
rm -rf /home/site/wwwroot/.python_packages /home/site/wwwroot/output.tar.zst /home/site/wwwroot/oryx-manifest.toml
```

### 2. Zip and deploy

```bash
zip -r mvfhis-backend-v2.zip app.py requirements.txt startup.txt backend/ static/ \
  -x "*.pyc" "*/__pycache__/*" ".DS_Store"

az webapp deploy --resource-group <rg> --name app-voiceform-cac1 \
  --src-path mvfhis-backend-v2.zip --type zip
```

Look for `Site started successfully`.

### 3. Smoke test

Open `https://app-voiceform-cac1.azurewebsites.net/`, log in, record all 12
fields, submit. Watch logs:
```bash
az webapp log tail --resource-group <rg> --name app-voiceform-cac1
```

---

## The API contract (for the teammate's Function App)

**Queue message** App Service drops on `voiceform-queue` (base64 JSON):
```json
{
  "submission_id": "<uuid>",
  "patient_email": "<email>",
  "blob_path": "temp-intake/<submission_id>-temp.pdf",
  "language": "fr-FR"
}
```

**What the Function App must do** (teammate owns this):
1. Read temp PDF from `temp-intake/<submission_id>-temp.pdf` (in `stfuncvoiceformcac`)
2. Document Intelligence → final formatted PDF
3. Upload final PDF → `pdfs/<submission_id>-final.pdf` (in `stvoiceformcac`)
4. Delete the temp PDF (PIPEDA)
5. Update the `submissions` table row:
   - PartitionKey = patient_email, RowKey = submission_id
   - set `status` = `completed`
   - set `blobPath` = `pdfs/<submission_id>-final.pdf`

Once the row reads `completed` + `blobPath`, App Service's `/api/status`
mints a User Delegation SAS and hands the download URL to the patient.

---

## Known considerations

- **Speech still needs WAV.** The browser converts each clip via
  `wav-encoder.js`. If anyone reverts the frontend to send webm, transcription
  breaks with `SPXERR_INVALID_HEADER`. Keep the WAV conversion.
- **Spoken email as a key.** Patients speak their email; we normalize
  "maria at gmail dot com" → "maria@gmail.com" for the Table PartitionKey.
  Imperfect — if STT garbles it, we fall back to the Easy Auth email. The
  frontend stores the returned `patientEmail` so polling uses the same key.
- **`/api/status` needs the email** as a query param since it's the
  PartitionKey: `/api/status/<id>?email=<email>`.
# trigger redeploy
