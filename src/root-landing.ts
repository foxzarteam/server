export const ROOT_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deployed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(145deg, #0f172a 0%, #1e3a5f 45%, #0c4a6e 100%);
      color: #e2e8f0;
      padding: 1.5rem;
    }
    .card {
      max-width: 28rem;
      text-align: center;
      padding: 2.5rem 2rem;
      border-radius: 1rem;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid rgba(148, 163, 184, 0.2);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(12px);
    }
    .mark {
      width: 3.5rem;
      height: 3.5rem;
      margin: 0 auto 1.25rem;
      border-radius: 50%;
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.75rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: #f8fafc;
      margin-bottom: 0.5rem;
    }
    p {
      font-size: 0.95rem;
      line-height: 1.55;
      color: #94a3b8;
    }
    code {
      display: inline-block;
      margin-top: 1.25rem;
      padding: 0.35rem 0.65rem;
      border-radius: 0.35rem;
      background: rgba(30, 58, 95, 0.6);
      color: #7dd3fc;
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="mark" aria-hidden="true">&#10003;</div>
    <h1>API set successfully</h1>
    <p>Your deployment is live on this domain. Use the REST API under <strong style="color:#cbd5e1">/api</strong> from your app.</p>
    <code>GET /api/health</code>
  </div>
</body>
</html>`;
