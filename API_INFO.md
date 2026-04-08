# API Endpoints (full reference)

Default local base: **`http://localhost:3000/api`**

- Global prefix: `api` (see `API_PREFIX` in env; default `api`).
- Port: `PORT` (default `3000`).
- Production / Vercel: use your deployed origin, e.g. `https://your-app.vercel.app/api`.

Common JSON shape: many routes return `{ success: boolean, data?: …, message?: string }`.

---

## Users (`/api/users`)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/users/mobile/:mobile` | User by mobile. `{ success, data }` — `data` null if not found. |
| **POST** | `/api/users` | Create user. Body: `CreateUserDto` (see below). **201** → `{ success, data }`. |
| **PUT** | `/api/users/upsert` | Insert or update user. Body: `UpsertUserDto`. |
| **PATCH** | `/api/users/mobile/:mobile/mpin` | Update MPIN. Body: `UpdateMpinDto`. |
| **PATCH** | `/api/users/mobile/:mobile/login-status` | Update login status. Body: `UpdateLoginStatusDto`. |
| **PATCH** | `/api/users/mobile/:mobile/profile` | Update profile. Body: `UpdateProfileDto`. |

**POST `/api/users` example body:**

```json
{
  "mobileNumber": "9876543210",
  "userName": "Optional",
  "email": "optional@example.com"
}
```

---

## OTP (`/api/otp`)

| Method | Path | Description |
|--------|------|-------------|
| **POST** | `/api/otp/send` | Send OTP. Body: `{ "mobileNumber": "9876543210" }` (10-digit Indian mobile). |
| **POST** | `/api/otp/verify` | Verify OTP. Body: `{ "mobileNumber": "9876543210", "otp": "123456" }`. |
| **GET** | `/api/otp/live` | Returns `{ "live": boolean }` from env `LIVE` (`true` / `1` → live). |
| **GET** | `/api/otp/dev` | HTML page with recent OTP rows (debug). **404** in production unless `ALLOW_OTP_DEV=true`. |

---

## Leads (`/api/leads`)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/leads` | Meta / health: lists related endpoints (no DB list of all leads). |
| **POST** | `/api/leads` | Create lead. **201** on success. |
| **GET** | `/api/leads/user/:userId` | All leads for user. |
| **GET** | `/api/leads/user/:userId/category/:category` | Leads for user filtered by category. |

**POST `/api/leads` body (`CreateLeadDto`):**

```json
{
  "pan": "ABCDE1234F",
  "mobileNumber": "9876543210",
  "fullName": "John Doe",
  "email": "john@example.com",
  "pincode": "110001",
  "requiredAmount": 50000,
  "category": "personal_loan",
  "userId": "optional-user-uuid"
}
```

**`category` allowed values:** `personal_loan`, `home_loan`, `business_loan`, `credit_card`, `insurance`, `vehicle_loan`

**Success response example:**

```json
{
  "success": true,
  "data": {
    "id": "lead-uuid",
    "pan": "ABCDE1234F",
    "mobile_number": "9876543210",
    "full_name": "John Doe",
    "category": "personal_loan",
    "status": "pending",
    "created_at": "2024-01-01T00:00:00.000Z"
  }
}
```

---

## Banners (`/api/banners`)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/banners` | All **active** banners (ordered). `{ success: true, data: BannerResponseDto[] }`. |
| **GET** | `/api/banners/category/:category` | Active banners for category (e.g. `carousel`, `promo`, `kyc`, `offer`). URL-encoded category OK. |
| **GET** | `/api/banners/all` | All banners (including inactive), ordered. |

**Banner item fields (camelCase):** `id`, `imageUrl`, `title`, `description`, `category`, `displayOrder`, `actionUrl`, `actionType`, `isActive`, `createdAt`, `updatedAt`.

---

## Services (`/api/services`)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/services` | Active rows only (`is_active = true`) from `public.services`, ordered by `sort_order`. |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "slug": "personal-loan",
      "title": "Personal Loan",
      "description": "Short blurb",
      "imageUrl": "https://…",
      "sortOrder": 0,
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

---

## Payment accounts (`/api/payment-accounts`)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/payment-accounts/user/:userId` | List payment accounts for user. `{ success: true, data: array }`. |
| **PUT** | `/api/payment-accounts/user/:userId` | Upsert payment account. Body: `UpsertPaymentAccountDto`. |

---

## Wallet (`/api/wallet`)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/wallet/user/:userId` | Wallet row for user. `{ success: true, data }` or `{ success: false, message: "Wallet not found" }`. |

---

## CORS

- Non-production: permissive origins (see `main.ts` / serverless `api/index.ts`).
- Production: optional allowlist via `ALLOWED_ORIGINS` (comma-separated).

---

## Related env (server)

Typical keys: Supabase URL + service key, `PORT`, `API_PREFIX`, `NODE_ENV`, `LIVE`, `ALLOW_OTP_DEV`, `ALLOWED_ORIGINS`. See project `.env.example` or deployment docs if present.
