# API list

Nest app **`server/`** folder se build hoti hai; global prefix **`api`** (`API_PREFIX`), isliye routes **`/api/...`** pe milte hain.

- **Local base:** `http://localhost:3000` → paths jaise `http://localhost:3000/api/auth/login`.
- **Deployed (az_web env):** `NEXT_PUBLIC_API_URL=https://server-nu-bay-20.vercel.app` (sirf origin, **bina** trailing `/api`) — az_web server-side isi par `fetch` karta hai, e.g.  
  **`POST https://server-nu-bay-20.vercel.app/api/auth/login`** — yahi **`public.auth`** login (Supabase read Nest ke through).

Base URL (local paths doc): `http://localhost:3000/api` — prefix `api`, port `PORT` (default 3000).

- **POST** `/auth/login` — Admin/staff: body `{ "email", "password" }` → Supabase `public.auth`. **Browser** az_web se seedha is URL pe `POST` karta hai (`NEXT_PUBLIC_API_URL` + `/api/auth/login`); pass hone par same site **`POST` az_web** `/api/admin/session` cookie set karta hai (server dubara verify karta hai).

- **GET** `/users/mobile/:mobile` — User row fetch by mobile number (not found → `data: null`).
- **POST** `/users` — New user create (duplicate mobile pe fail).
- **PUT** `/users/upsert` — User insert ya same mobile par partial update.
- **PATCH** `/users/mobile/:mobile/mpin` — MPIN set/update.
- **PATCH** `/users/mobile/:mobile/login-status` — Login / logout status aur `last_login_at`.
- **PATCH** `/users/mobile/:mobile/profile` — `userName` / `email` update.

- **POST** `/otp/send` — Dev flow: DB me OTP session banata hai (SMS yahan nahi).
- **POST** `/otp/verify` — OTP verify karke session marked verified.
- **GET** `/otp/live` — Env `LIVE` se `{ live: boolean }`.
- **GET** `/otp/dev` — Recent OTP rows ki HTML debug page (prod me usually 404, `ALLOW_OTP_DEV=true` se allow).

- **GET** `/leads` — API info / related routes ka short meta (DB list nahi).
- **POST** `/leads` — Naya lead create (duplicate mobile same user pe rokta hai).
- **GET** `/leads/user/:userId` — Us user ke active leads.
- **GET** `/leads/user/:userId/category/:category` — User leads category se filter.

- **GET** `/banners` — Sab active banners ordered.
- **GET** `/banners/category/:category` — Active banners us category ke.
- **GET** `/banners/all` — Sab banners (inactive bhi).

- **GET** `/services` — Active services list, `sort_order` se ordered.

- **GET** `/payment-accounts/user/:userId` — User ke payment accounts list.
- **PUT** `/payment-accounts/user/:userId` — UPI ya bank row upsert (`user_id` + `payment_type` conflict).

- **GET** `/wallet/user/:userId` — User wallet row (balance, earning, redeem, etc.).
