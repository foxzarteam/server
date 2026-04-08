# Vercel Deployment Guide

## Vercel Project Setup

1. **Vercel Dashboard में Project Settings:**
   - Root Directory: `server` (यह important है!)
   - Framework Preset: `Other`
   - Build Command: `npm run build` (optional, Vercel auto-detect करेगा)
   - Output Directory: `dist` (NestJS build output, लेकिन serverless functions के लिए जरूरी नहीं)
   - Install Command: `npm install`

2. **Environment Variables (Vercel Dashboard → Settings → Environment Variables):**
   ```
   SUPABASE_URL=https://udimpjtffznuuebwiozv.supabase.co
   SUPABASE_SERVICE_KEY=your-service-key-here
   API_PREFIX=api
   NODE_ENV=production
   ```

## Project Structure

```
server/
├── api/
│   └── index.ts          # Vercel serverless function entry point
├── src/                  # NestJS source code
├── vercel.json           # Vercel configuration
└── package.json
```

## API Endpoints

Deploy के बाद, आपकी API इन endpoints पर available होगी:

- `https://az-project.vercel.app/api/users/*`
- `https://az-project.vercel.app/api/otp/*`

## Troubleshooting

### 404 Error आ रहा है:

1. **Check करें कि Vercel Project का Root Directory `server` है:**
   - Vercel Dashboard → Project Settings → Root Directory = `server`

2. **Check करें कि `api/index.ts` file exists:**
   - File path: `server/api/index.ts`

3. **Environment Variables check करें:**
   - सभी required variables set हैं या नहीं

4. **Build Logs check करें:**
   - Vercel Dashboard → Deployments → Latest Deployment → Build Logs

5. **Redeploy करें:**
   - Latest commit push करें या manually redeploy करें

### TypeScript Compilation Issues:

- Vercel automatically TypeScript compile करता है `api` folder में
- Ensure करें कि `tsconfig.json` properly configured है

## Testing Locally

Vercel CLI से locally test करने के लिए:

```bash
cd server
npm install -g vercel
vercel dev
```

## Important Notes

- `api/index.ts` file Vercel के serverless function format में होनी चाहिए
- NestJS app को Express adapter के साथ initialize करना होगा
- CORS properly configured होना चाहिए production के लिए
