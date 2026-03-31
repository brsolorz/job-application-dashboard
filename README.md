# Job Application Dashboard

Frontend MVP for tracking job applications, interviews, and action items.

## What it does

- Imports `.csv`, `.xlsx`, and `.xls` files
- Accepts Google Sheets links and converts them to CSV export URLs
- Maps varied spreadsheet headers into a shared job application model
- Persists imported and edited records in browser local storage
- Highlights active interview loops, open tasks, and simple funnel stats
- Lets users edit records inline after import

## Smart import behavior

The importer looks for common column names and synonyms, including:

- `company`, `employer`, `organization`
- `role`, `title`, `position`
- `status`, `stage`, `pipeline`
- `applied`, `submitted`, `application date`
- `todo`, `next step`, `follow up`, `task`
- `recruiter`, `contact`, `hiring manager`
- `notes`, `details`, `summary`

Columns that do not match the initial schema are left unmatched for now. A later version can expose a manual field-mapping UI for those columns.

## Development

```bash
npm install
npm run dev
```

## Next logical expansions

- Manual field mapping for unmatched headers
- Saved views and filters by status or company
- Calendar-style follow-up reminders
- Auth and backend sync
- Native Google Sheets OAuth import for private sheets
