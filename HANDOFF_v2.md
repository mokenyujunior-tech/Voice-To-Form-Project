# MVFHIS — v2 Handoff (field-by-field, Managed Identity)

This is the App Service side only. The Function App is the teammate's.

## What's here
- `backend-app/` — Flask app + frontend, updated to the v2 spec:
  - 12 fields recorded one at a time, held in browser as WAV, submitted together
  - Managed Identity for all Storage (no keys)
  - Builds the TEMP PDF → temp-intake; Function App makes the final one
  - Browser converts audio to WAV (fixes the earlier SPXERR_INVALID_HEADER)

## Read next
`backend-app/README.md` — full env vars, Managed Identity roles, deploy steps,
and the queue-message contract the Function App consumes.

## Status
- All code syntax-checked; app.py imports cleanly; temp PDF generation verified.
- NOT yet deployed to app-voiceform-cac1 or live-tested end to end.
- Field keys verified to match exactly between frontend and backend.

## Still needs a real test
Deploy to app-voiceform-cac1 and run the full flow once. The main things that
can only be confirmed live:
1. Managed Identity actually has queue + table roles (not just blob) —
   see README "Managed Identity prerequisites"
2. WAV conversion produces audio the Speech SDK accepts (the whole point of
   wav-encoder.js — should fix the earlier error, but confirm on device)
3. The spoken-email → PartitionKey normalization works acceptably
