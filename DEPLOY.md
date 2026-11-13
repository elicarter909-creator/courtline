# Deploy Courtline (Render)

1. Create a new GitHub repo and upload everything in this folder (do NOT upload your real `.env`).
2. On render.com: New > Web Service > connect that repo.
3. Settings: Runtime Node, Build Command `npm install`, Start Command `npm start`.
4. Environment > add `SPORTSGAMEODDS_API_KEY` with your key.
5. Deploy. Render gives you a public URL; the app reads the PORT it assigns automatically.

Notes
- Anyone with the URL can use the site, and each visit can spend your API quota. Keep the URL private or ask for a password gate.
- Free hosting sleeps when idle, and saved line history / alert watches reset on redeploy unless you add a persistent disk.
- Railway and Fly.io work the same way: Node app, start command `npm start`, key as an env variable.
