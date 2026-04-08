# Bankers API (NestJS)

Backend for **Apni Zaroorat** app. Uses Supabase as database. All app flows use REST APIs only.

## Setup

1. **Install**
   ```bash
   # From root directory (apnizaroorat/)
   cd server
   npm install
   ```

2. **Env** (file **`server/.env`** in project root)
   - Copy `env.example` to `.env` and fill values
   - `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (Dashboard → Settings → API → service role)
   - `LIVE=true|false`
     - Controls client OTP flow:
       - `LIVE=true`: Flutter uses Firebase Phone Auth to send OTP to phone.
       - `LIVE=false`: Flutter creates OTP sessions via `/api/otp/send` and you can view OTPs on `/api/otp/dev`.

3. **Run**
   ```bash
   npm run start:dev
   ```
   API: `http://localhost:3000/api`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/mobile/:mobile` | Get user by mobile |
| POST | `/api/users` | Create user |
| PUT | `/api/users/upsert` | Upsert user (create or update) |
| PATCH | `/api/users/mobile/:mobile/mpin` | Update MPIN |
| PATCH | `/api/users/mobile/:mobile/login-status` | Update login status |
| PATCH | `/api/users/mobile/:mobile/profile` | Update profile |
| GET | `/api/otp/live` | Returns `{ live: boolean }` for client flow selection |
| POST | `/api/otp/send` | Create OTP session `{ "mobileNumber": "9876543210" }` (used when `LIVE=false`) |
| POST | `/api/otp/verify` | Verify OTP `{ "mobileNumber": "...", "otp": "1234" }` |

## Project layout

- `src/config/supabase.ts` – global Supabase client
- `src/*/*.module.ts` – one file per domain (controller + service + DTOs)

See `API_INFO.md` for route list.
