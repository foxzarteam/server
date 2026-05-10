# Bankers API (NestJS)

Backend for **Apni Zaroorat** app. Uses Supabase as database. All app flows use REST APIs only.

## Setup

1. **Install**
   ```bash
   # From root directory (apnizaroorat/)
   cd server
   npm install
   ```

2. **Env** (`server/.env` and/or **`server/.env.local`**, same idea as `az_web`)
   - Copy `env.example` to `.env` or `.env.local` and fill values (both are gitignored; `.env.local` overrides `.env`)
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
| POST | `/api/auth/login` | **Admin panel:** body `{ "email", "password" }` → checks `public.auth` in Supabase, returns `{ ok, user }`. **az_web** calls this from `POST /api/admin/login` (Next sets the session cookie). |
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
- `src/auth/auth.module.ts` – admin/staff login vs `public.auth`
- `src/*/*.module.ts` – one file per domain (controller + service + DTOs)

See `API_INFO.md` for route list.
