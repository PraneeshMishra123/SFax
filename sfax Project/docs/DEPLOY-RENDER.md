# Deploy SFAX on Render.com (website) and connect the Print app

Important: Render hosts only the WEBSITE (a Node web service). The Print app is a Windows program that runs on each
post office computer. It is not hosted on Render. It is connected to the website by one setting: the website address
in the app's `config.json`.

You need free accounts at: GitHub, Render, Upstash (database), Brevo (email, optional but recommended).

## Part A. Put the website on Render

### 1. Database (Upstash)
1. upstash.com > Create database (Redis, any region near you, free plan).
2. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (REST tab).

### 2. Your keys (once, on your own computer, with Node.js 20+)
1. Unzip `sfax-project.zip`. In that folder run: `node tools/owner-tool.js keygen`
2. It creates `escrow-master-PRIVATE.json`. Keep it offline, make 2 copies, never upload it.
3. It prints a public key (`ESCROW_PUBLIC_KEY`) and a fingerprint. Note both. The fingerprint goes into the Print app later.
4. Make two long random secrets (30+ characters each): one for `SESSION_SECRET`, one for `ADMIN_TOKEN`.
   Keep them in a safe place. Never change `SESSION_SECRET` later.

### 3. GitHub
1. Create a repository, e.g. `sfax-site` (private is fine).
2. Upload the CONTENTS of `sfax-project.zip` (server.js, package.json, public, tools, docs ...), not the zip itself.

### 4. Render web service
1. render.com > New > Web Service > connect the repository.
2. Runtime: Node. Build command: `npm install`. Start command: `node server.js`. Plan: Free.
3. Environment > add:

| Name | Value |
|---|---|
| `SESSION_SECRET` | your long random text |
| `ADMIN_TOKEN` | your long random text |
| `ESCROW_PUBLIC_KEY` | printed by keygen |
| `UPSTASH_REDIS_REST_URL` | from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash |
| `MAIL_FROM`, `BREVO_API_KEY` | see docs/OPERATIONS.md (email codes, password reset) |
| `SITE_URL` | your Render address, no slash at the end (needed for Google sign-in) |
| `MIN_APP_VERSION` | leave empty for now |

4. Create Web Service. Wait for the log line "SFAX running". Your address looks like `https://sfax-xxxx.onrender.com`.
5. Open `https://YOUR-SITE.onrender.com/health`. It should answer OK.

### 5. Create the one admin account
1. Open `https://YOUR-SITE.onrender.com/admin`.
2. Choose "Create the admin account". Enter the `ADMIN_TOKEN`, your email and a password (10+ characters). This works once.
   No second admin can ever be created. If you lose access, use "Lost access?" with the `ADMIN_TOKEN`.
3. Admin > Email tab > "Send test email". Fix it if it reports an error.

### 6. Keep the free site awake (optional)
uptimerobot.com > HTTP(s) monitor on `https://YOUR-SITE.onrender.com/health` every 5 minutes.

## Part B. Build the Print app and connect it to the website
Do this on a Windows computer with Node.js 20+ and internet.

1. Unzip `sfax-print-app.zip` to `C:\sfax-print-app`. (If you already have the folder, unzip `sfax-print-app-update.zip` over it,
   then run `node update-package.js`. This sets version 1.0.4 and keeps your GitHub name.)
2. Open `config.json` and set:
   - `"server"`: your Render address, e.g. `https://sfax-xxxx.onrender.com` (this is the connection to the website)
   - `"escrowFingerprint"`: the fingerprint printed by keygen in Part A step 2
3. Open `package.json` > `build.publish` and set `owner` to your GitHub name (repo `sfax-print`).
4. In the folder run: `npm install`, then `npm start` to try it (log in with a post office PIN and password).
5. Build the installer: `npm run dist`. You get `dist\SFAX-Print-Setup.exe`.
6. GitHub: create a repository named `sfax-print`. Releases > Draft a new release, tag `v1.0.4`, attach `SFAX-Print-Setup.exe` and
   `latest.yml` from `dist`, publish. (For automatic updates run `npx electron-builder --win --publish always` with a `GITHUB_TOKEN`.)
7. Back on Render > Environment add:
   `APP_DOWNLOAD_URL` = `https://github.com/YOUR-GITHUB-NAME/sfax-print/releases/latest/download/SFAX-Print-Setup.exe`
   Save. Render redeploys. Now new post offices see a download popup after registering.
8. When every post office has the new app, set `MIN_APP_VERSION` = `1.0.4` on Render. Do this only after they have updated,
   or they will be locked out.

## Part C. Check the whole chain
1. Website: register a post office (PIN) and a sender.
2. Install SFAX Print on the post office computer, log in with the PIN and password, press "Create key on this computer".
3. Sender sends a test message to that PIN.
4. In the Print app the message appears. Choose the dot matrix printer and print. Sheet 1 has the letterhead with both logos, the date and time of printing beside the "Do not open" note,
   and Sender, Receiver and Date (left side) under ACKNOWLEDGMENT. The message prints on 3 sheets (setting `layout.messageSheets` in `config.json`).

## Updating later
- Website: upload changed files to GitHub. Render redeploys by itself.
- Print app: raise the version in `package.json`, `npm run dist`, publish a new GitHub release.

## Notes
- Render's free plan sleeps after 15 minutes idle; the first request takes about 30 seconds.
- The two logos on the printed sheet come from `assets` in the Print app. The website shows only the Trigun logo.
- I could test the server and the sheet layout automatically. The Windows app and a real dot matrix printer were not tested here.
  Print one test sheet first.
