# API list

Nest app **`server/`** folder se build hoti hai; global prefix **`api`** (`API_PREFIX`), isliye routes **`/api/...`** pe milte hain.

- **Local base:** `http://localhost:3000` → paths jaise `http://localhost:3000/api/auth/login`.
- **Deployed (az_web env):** `NEXT_PUBLIC_API_URL=https://server-nu-bay-20.vercel.app` (sirf origin, **bina** trailing `/api`) — az_web server-side isi par `fetch` karta hai, e.g.  
  **`POST https://server-nu-bay-20.vercel.app/api/auth/login`** — yahi **`public.auth`** login (Supabase read Nest ke through).

Base URL (local paths doc): `http://localhost:3000/api` — prefix `api`, port `PORT` (default 3000).

- **POST** `/auth/login` — Admin/staff: body `{ "email", "password" }` → Supabase `public.auth`. **Browser** az_web se seedha is URL pe `POST` karta hai (`NEXT_PUBLIC_API_URL` + `/api/auth/login`); pass hone par same site **`POST` az_web** `/api/admin/session` cookie set karta hai (server dubara verify karta hai).

- **GET** `/users/mobile/:mobile` — Auth required (OTP / Firebase idToken / admin key). Returns user **without** `mpin` (`has_mpin` flag).
- **POST** `/users` — Auth required. New user create.
- **PUT** `/users/upsert` — Auth required.
- **PATCH** `/users/mobile/:mobile/mpin` — Auth required. Stores **bcrypt-hashed** MPIN.
- **POST** `/users/mobile/:mobile/verify-mpin` — Auth required. Body `{ mpin }` → `{ success }` (does not return hash).
- **PATCH** `/users/mobile/:mobile/login-status` — Auth required.
- **PATCH** `/users/mobile/:mobile/profile` — Auth required.

- **POST** `/otp/send` — Dev flow: DB me OTP session banata hai (SMS yahan nahi).
- **POST** `/otp/request-send` — Rate-limit check + send row before Firebase SMS.
- **POST** `/otp/verify-firebase` — Firebase ID token verify (az_web). Body: `{ mobileNumber, idToken }`.
- **GET** `/otp/live` — Env `LIVE` se `{ live: boolean }`.
- **GET** `/otp/dev` — Recent OTP rows ki HTML debug page (prod me usually 404, `ALLOW_OTP_DEV=true` se allow).

- **GET** `/leads` — API info / related routes ka short meta (DB list nahi).
- **POST** `/leads/apply` — Public apply (az_web form). Duplicate mobile/PAN block.
- **POST** `/leads/start` — Requires recent OTP verification.
- **POST** `/leads` — Auth required (OTP / idToken / admin key).
- **PATCH** `/leads/:id/complete` — Auth required for that lead’s mobile.
- **GET** `/leads/user/:userId` — Auth required (owner OTP or admin key). PAN/notes stripped.
- **GET** `/leads/user/:userId/category/:category` — Same auth as above.

- **GET** `/payment-accounts/user/:userId` — Auth required (owner OTP / idToken / admin key).
- **PUT** `/payment-accounts/user/:userId` — Auth required.

- **GET** `/wallet/user/:userId` — Auth required.

**Auth for mobile routes:** `x-admin-internal-key` **or** recent verified OTP for that mobile **or** `x-firebase-id-token` / `Authorization: Bearer` / body `idToken`.

**Production fail-closed:** `ADMIN_INTERNAL_KEY` + `ALLOWED_ORIGINS` required. Admin passwords must be bcrypt (plaintext login disabled).

- **POST** `/customer/check-mobile` — Public. Body: `{ mobileNumber }` → `{ success, exists }` (active lead for that mobile?).
- **POST** `/customer/login` — Public. Body: `{ mobileNumber, idToken }` → Firebase verify + applications. Response: `{ success, customer, applications }` ya error (`NO_APPLICATION` / `LOGIN_FAILED`). az_web isse session cookie set karta hai.
- **POST** `/customer/applications` — Internal (`x-admin-internal-key`). Body: `{ mobileNumber }` → `{ success, customer, applications }` (dashboard /me BFF).

- **POST** `/contact` — Public contact form. Body: `{ name, email, phone, message }` → `{ success, id }`.
- **GET** `/contact/admin/all` — Internal key. Sab contacts (newest first).
- **PATCH** `/contact/admin/:id` — Internal key. Update name/email/phone/message/status.
- **DELETE** `/contact/admin/:id` — Internal key. Delete contact.

- **POST** `/chat` — Public loan-helper chat start. Body: `{ mobileNumber, answers, status? }` → `{ success, id, status }`.
- **PATCH** `/chat/:id` — Auth required (OTP / idToken / admin key for that chat’s mobile). Update `status` / `leadId`.
