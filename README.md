# MightyCall Web Dialer (local)

Simple web dashboard that:

- Fetches your MightyCall business phone numbers (`GET /phonenumbers`)
- Places outbound calls (`POST /calls/makecall`)
- Supports **multiple concurrent calls** by triggering `makecall` in parallel for multiple “from” numbers

## Security first

Your screenshot contained an API key and user key. Treat those as **compromised**:

- Recreate/rotate the key(s) in MightyCall
- Never put them into frontend code

This app keeps credentials server-side in a local `.env` file.

## Requirements

- Node.js 18+ (so `fetch()` exists)

## Setup

1. Create `.env` from `.env.example`

2. Fill:

- `MIGHTYCALL_API_KEY`
- `MIGHTYCALL_SECRET_KEY` (your **User Key** or extension number, depending on your account setup)

3. Install and run:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## How it works

- Backend gets an auth token using `POST /auth/token` (client credentials flow)
- Backend caches the token in memory and refreshes it automatically when it expires
- Frontend calls only local endpoints under `/api/*`

