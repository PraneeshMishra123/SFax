# SFAX – private messages for your close ones

## Run on your own computer
1. Install Node.js 18 or newer from https://nodejs.org
2. In this folder run:  node server.js
3. Open http://localhost:3000   (data is saved in data.json)

## Put it online, always on, for free (data never lost)

### 1. Free online database (Upstash)
- Sign up at https://upstash.com (no credit card needed for the free tier).
- Create a Redis database and open its REST API section.
- Copy the two values: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.

### 2. Deploy on Render
- Upload the files in this folder to a GitHub repository (files at the top level, not inside another folder).
- Render -> New -> Web Service -> choose the repository.
- Runtime: Node.  Build command: (empty or npm install).  Start command: node server.js.  Plan: Free.
- Under Environment add three variables:
    UPSTASH_REDIS_REST_URL    = (value from step 1)
    UPSTASH_REDIS_REST_TOKEN  = (value from step 1)
    SESSION_SECRET            = (any long random text, e.g. 40 random characters)
- Deploy. You get a link like https://sfax.onrender.com

### 3. Keep it awake (free plan sleeps after 15 minutes without visits)
- Sign up at https://uptimerobot.com (or cron-job.org).
- Add a monitor of type HTTP(s) for  https://YOUR-APP.onrender.com/health  every 5 minutes.

Accounts and messages are stored in the Upstash database, so restarts and redeploys do not delete them.

## Dot matrix printing without preview (post office computer)
Set the dot matrix printer as the default printer, then start Chrome/Edge with:
  chrome.exe --kiosk-printing https://YOUR-APP.onrender.com

## How a message is sent (by post only)
- The sender enters the receiver's name, both email IDs, both addresses and both post office PINs.
- Typing an address suggests nearby post offices (India Post PIN lookup, needs internet). Tap one to fill its PIN.
- The destination PIN must belong to a post office that has registered on SFAX.

## Printing (3 sheets)
- Sheet 1: receiver details on the left, sender details on the right, then a dotted tear line with
  ACKNOWLEDGMENT (Post Officer Sign and Receiver Sign) at the bottom.
- Sheet 2: the message.
- Sheet 3: blank, so the message cannot be read until the paper is opened.

## Files
- server.js          backend (API, login, storage)
- public/index.html  the website
- package.json       start settings for Render


## Privacy: end-to-end encryption (stage 1)
- The sender's browser encrypts the message, both addresses and both email IDs with the destination post office's
  public key (AES-256-GCM, key wrapped with RSA-OAEP 3072). The server stores only ciphertext plus routing details
  (sender name, recipient name, PINs, times).
- The post office's private key is created on the post office computer and never sent to the server.
- Until the SFAX Print app (stage 2) exists, `tools/po-tool.js` creates the key and can read messages (test tool).
- Messages can only be sent to a post office that has set up its key.

## Backup key held by the owner (key recovery)
Every post office private key is also uploaded as an ENCRYPTED backup that only the owner's master key can open.
The master key is created on the owner's own computer and kept OFFLINE. The server only has its public half.
This lets the owner recover a lost key, but it also means the owner can read any post office's messages.

One-time owner setup (on your own computer, not the server):
1. `node tools/owner-tool.js keygen`  -> creates `escrow-master-PRIVATE.json` (keep offline, make 2 copies, never upload).
2. In Render > Environment add `ESCROW_PUBLIC_KEY` (printed by the command) and `ADMIN_TOKEN` (a long random secret).
3. Give every post office the fingerprint printed by the command, so they can check it during setup.

Post office setup (on the post office computer):
`node tools/po-tool.js setup https://YOUR-SITE.onrender.com 500016 PASSWORD`

Recovery when a post office loses its key (do NOT rely on a Gmail message alone):
1. Verify identity another way: call the post office's official number, check their ID / official letter.
2. `node tools/owner-tool.js restore https://YOUR-SITE.onrender.com 500016` -> creates `recovery-500016.json`.
3. Email the file; tell the one-time passphrase by phone, never in the same email. Delete the file afterwards.
4. The post office uses it as its key file: `node tools/po-tool.js read <server> <PIN> <password> recovery-500016.json`.

Never commit `escrow-master-PRIVATE.json`, `*.key.json` or `recovery-*.json` to GitHub.

## Stage 2: SFAX Print app and forcing it
- The Windows app for post offices is a separate download (`sfax-print-app.zip`, see its README).
- In Render > Environment set `MIN_APP_VERSION` (for example `1.0.0`). The server then releases encrypted messages only to
  the app (and newer versions). The `tools/po-tool.js read` test tool stops working once this is set, which is intended.
