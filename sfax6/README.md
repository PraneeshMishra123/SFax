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
