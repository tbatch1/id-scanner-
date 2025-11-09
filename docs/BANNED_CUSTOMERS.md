## Banned Customer Management

### API Endpoints

All endpoints require the standard kiosk API key (if configured) and a running Postgres instance.

- `GET /api/banned` – list current entries.
- `POST /api/banned`
  ```json
  {
    "documentType": "passport",
    "documentNumber": "P1234567",
    "issuingCountry": "USA",
    "dateOfBirth": "1992-05-06",
    "firstName": "John",
    "lastName": "Doe",
    "notes": "Chargeback fraud"
  }
  ```
- `DELETE /api/banned/:id` – remove by entry id.

`documentType` + `documentNumber` + `issuingCountry` (empty string if omitted) are unique. Notes are optional and trimmed.

### Verification Flow

1. On every scan, the backend checks the banned list before recording the verification.
2. If matched, the attempt is logged, the verification is stored as `rejected` with the supplied note, and the kiosk shows a flagged status (“ID is banned. Follow escalation protocol.”).
3. Auto-complete is suppressed for banned IDs even if the age is 21+.

### Clerk SOP

- When “ID is banned” appears, stop the sale and follow the escalation procedure (notify manager, retain ID only if policy allows).
- Use the `Scan Another ID` button to reset the flow once the situation is resolved.

### Testing Checklist

- Add a banned record via `POST /api/banned`.
- Scan an ID with matching document number → kiosk should flag, backend should log `banned_customer_attempt`, and Postgres should store a rejected verification with the ban reason.
- Delete the banned record and rescan → verification should succeed and auto-complete if 21+.

### Manager Overrides
- Overrides require the manager PIN (`OVERRIDE_PIN` in the backend environment).
- On the kiosk, clerks press **Manual Entry** to open the override form, which captures manager ID, PIN, and a note.
- Successful overrides mark the original verification as `approved_override` and log the event in `verification_overrides`. Sales can then be completed normally.
- Review overrides weekly to ensure notes are complete and policies are followed.

### CLI Helpers
`
npm run banned:list
npm run banned:add -- <documentType> <documentNumber> [issuingCountry] [note]
npm run banned:remove -- <id>
`
These commands use the same database connection configured via DATABASE_URL.
