# SFAX operations guide

## Settings (Render > Environment)
| Name | What it does | Needed for |
|---|---|---|
| `SESSION_SECRET` | Long random text. Signs logins and protects messages that wait for an app. Never change it. | Required |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | The online database. Without them data is lost on restart. | Required |
| `ESCROW_PUBLIC_KEY` | Public half of your offline backup key (from `owner-tool.js keygen`). | Post office key setup |
| `ADMIN_TOKEN` | Long random secret for `/admin` and key recovery. | Admin dashboard |
| `APP_DOWNLOAD_URL` | Link to the installer (GitHub release). | Download buttons |
| `MIN_APP_VERSION` | Oldest Print app version allowed, e.g. `1.0.1`. | Forcing the app |
| `MAIL_FROM` and `BREVO_API_KEY` (or `RESEND_API_KEY`) | Sends forgot-password codes and "printed" emails. | Password reset |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_HOURS`, `ORG_NAME`, `ORG_ABOUT`, `ORG_ADDRESS` | Fills the Support section and footer on the homepage. Leave empty to hide it. | Contact details |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SITE_URL` | "Continue with Google" for senders (see below). `SITE_URL` is your site address, e.g. `https://sfax-xxxx.onrender.com`. | Google sign-in |
| `ADMIN_NOTIFY_EMAIL` | Optional. Where help-request emails go (default: the admin's own email). | Optional |
| `RETAIN_PRINTED_DAYS` (30), `EXPIRE_UNPRINTED_DAYS` (90) | When old messages are deleted. If you change them, update the Privacy and FAQ text on the homepage. | Optional |

## Setting up email (free, about 10 minutes)
Render's free plan blocks normal email (SMTP), so SFAX sends email through a web service.
1. Create a free account at brevo.com. Under Senders, add and verify the email address you want codes to come from (a Gmail address works).
2. In Brevo go to SMTP and API > API keys and create a key.
3. On Render add `BREVO_API_KEY` (the key) and `MAIL_FROM` (the verified sender address). Save.
4. Open `/admin`: "Email for codes and notifications" should say on.
Brevo's free plan allows about 300 emails a day. Check your spam folder when testing.

## The admin account (one account only)
Open `https://YOUR-SITE.onrender.com/admin`.
1. **First time:** choose "Create the admin account". Enter the `ADMIN_TOKEN` (the value on Render), your email and a password of 10+ characters. This works once. There is never a second admin.
2. **Every time after:** login with email and password. If email is set up, a 6-digit code is emailed to you as the second step. Sessions last 8 hours.
3. **Forgot the password:** "Forgot password?" emails a code to the admin email.
4. **No access to that email, or email is broken:** "Lost access?" with the `ADMIN_TOKEN` lets you replace the admin email and password. Keep `ADMIN_TOKEN` safe: whoever has it can take over the admin account.

What the admin can do: see totals and a settings check; set a new password (typed or generated) or create a one-time 8-digit code for any sender or post office; suspend or enable an account; delete an account with its messages; add a recovery email to a post office; answer help requests; set an announcement banner, pause new messages, and edit the support details; send a test email; download a backup. The admin can never read a message, and the activity log never holds message text.

## Making email work (Brevo) - step by step
Until this works, no codes are sent: users cannot reset passwords, and your own admin login has no emailed code.
1. Go to brevo.com and create a free account.
2. In Brevo open **Senders, Domains & Dedicated IPs > Senders** and add the email address codes should come from (a Gmail address is fine). Brevo emails you a link: open it to verify the address. Unverified senders are rejected.
3. In Brevo open **SMTP & API > API keys** and create a key. Copy it once (it is shown only once).
4. On Render open your service > **Environment** and add `BREVO_API_KEY` (the key, no spaces or quotes) and `MAIL_FROM` (the verified sender address, exactly as in Brevo). Save and wait for "SFAX running" in the Logs.
5. Open `/admin` > **Email** and press **Send test email**. It says "Sent" or shows the exact reason it failed (for example `Brevo answered 401` = wrong key, or a sender that is not verified). Check the spam folder too.
6. Once the test arrives, the admin login code, password-reset codes, help-request notices and "message printed" emails all work.
Brevo's free plan allows about 300 emails a day.

## Sign in with Google (optional, senders only)
1. Go to console.cloud.google.com, create a project, open **APIs & Services > OAuth consent screen** and fill in the app name (Trigun Robotics SFAX) and your email. Publish the app so any Google account can use it.
2. Open **Credentials > Create credentials > OAuth client ID**, type **Web application**.
3. Under **Authorized redirect URIs** add exactly: `https://YOUR-SITE.onrender.com/api/auth/google/callback`
4. Copy the Client ID and Client secret. On Render add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SITE_URL` (`https://YOUR-SITE.onrender.com`, no slash at the end). Save.
5. The Sender login page now shows **Continue with Google**. The first time someone uses it, a sender account is created from their verified Google email and name. Post offices do not use Google: they sign in with their PIN.
If the button does not appear, one of the three settings is missing. The Overview tab shows "Google sign-in: on/off".

## Post office directory (address suggestions)
Senders type the receiver's address and the page suggests the nearest post office and PIN. The suggestions come from the India Post "All India Pincode Directory" kept on the server.
1. Download the directory (CSV) from data.gov.in (search "All India Pincode Directory"). Rename it `pincodes.csv`. If it is large, compress it to `pincodes.csv.gz` (about a quarter of the size; GitHub's website upload limit is 25 MB per file).
2. Put it in the `data` folder of the website repository and let Render redeploy. Or set `PINCODE_FILE` to another path.
3. In `/admin`, Overview shows "Post office directory: N offices loaded". If it says "not loaded", the file name or columns were not recognised (it needs at least officename and pincode; district, statename, officetype and delivery improve the results).
Until the file is added, the page falls back to a public PIN lookup service.
Suggestions are ranked by: a PIN typed in the address (exact), then the office name found in the address, the district and state, the sender's own saved PIN area, and offices that deliver. Each PIN is marked "on SFAX" when a post office has registered at it, because a message can only be sent to a registered PIN. Where there is none, the nearest registered post offices in the same district or state are offered. The text typed for suggestions is not stored or logged.

## Sender name, address and PIN
A sender's name is taken from the login email (or the Google account), not typed. After the first login the sender is asked once for their address and PIN, saved with the account and used to fill in the sender email and address on every message. The sender can change their name, address and PIN at any time with the 📍 My details button (the login email cannot be changed, because it is the verified identity). These saved details are readable by the server (the privacy text on the site says so); the addresses written inside each message stay encrypted.

## Collection code (receiver collected the post)
Every message has its own 8-character collection code (like K7M2-9QX4). The Print app prints it on sheet 1, on the tear-off slip under ACKNOWLEDGMENT, and the sender sees the same code on the message card and in History. When the receiver has signed, the post office tears off the slip and types the code in the Code box on the website (Post office login). The sender then sees the message as Collected, and gets an email if email is set up.
- The code is worked out from the message with the server secret, so nothing extra is stored and it cannot be guessed. The post office website lists never show it.
- It works only at the post office the message was sent to, only once, and only after the message is printed. Wrong guesses are slowed down.
- Limit: the post office person can read the printed code, so the code on its own does not prove the receiver was there. It proves the slip was torn off and its code typed.
- Print app version 1.0.6 or newer prints the code. Older versions print no code, so those messages cannot be marked collected.

## Sender history, sent copies and deleting
The sender's History (🕘 on the left strip) lists everything they sent with numbers, filters, search and a detail view with a timeline. When a message is deleted (30 days after printing, 90 days if never printed) or the sender deletes it, only a tiny record stays: who it was for (the name typed), the post office PIN, the dates and the status, never the message, addresses or email IDs. These records are kept for 180 days (`HISTORY_DAYS`). Every record is one entry in the single database file, so for very high volume plan a real database.
- A sender can delete a message until it is printed (from the list or from History). It is removed for good and shows as Deleted in History.
- The sender can read what they wrote only from a copy kept in their own browser on the device they sent from. SFAX cannot read messages and has no copy. It can be switched off in My details (📍), and copies can be removed one by one. Other devices show no copy.

## Known places (colleges, hospitals, landmarks)
The India Post directory only knows post offices, so a college name such as "Indian Institute of Information Technology Design and Manufacturing Kurnool" is not in it. List such places yourself in `data/places.csv` (see `data/places.example.csv`): name, aliases separated by |, PIN, and optionally district and state. A listed place is suggested first, with its PIN and the post office that serves it. `/admin` Overview shows how many are listed. Confirm each PIN with the place or the post office before you list it.

## Stopping fake accounts (email proof)
Once email is set up (MAIL_FROM and BREVO_API_KEY), a new sender must enter a 6-digit code sent to their email before the account is created. Nobody can sign up with a made-up address or someone else's. Google sign-in already needs a Google-verified email.
Every website login (sender and post office) then needs the emailed 6-digit code after the password, and nothing needs to be switched on by the user. The Print app is exempt, post offices with no recovery email cannot receive codes so they are not asked, and Google sign-in is already verified by Google. To switch the code off for everyone, set `REQUIRE_LOGIN_CODE` = `0` on Render. Keep an eye on the Brevo test email: if email stops working, nobody can log in on the website.
Accounts created before this change were never email-checked. Review them in `/admin` and suspend any you do not recognise.

## Login code by email
The code is part of every website login once email is set up (see above). There is no settings screen for it. Senders can use the ⌂ Home button inside their account to see the public home page without logging out, and "Back to my account" brings them back.

## Logos
The logo file is `public/assets/trigun-logo.png`. To change it, replace the file with one of the same name. The IIITDM Kurnool logo is not on the website; it is printed only on the first sheet by the Print app. They appear on the homepage, login pages and admin page. In the Print app the same two files are in its `assets` folder.

## A post office forgot its password and has no recovery email
1. They press **Cannot use a code? Email the admin** on the forgot-password screen. This creates a request in the admin page (Help requests tab) and emails you.
2. Check who is asking. For example, call the post office on its official number, or ask for an official letter or ID.
3. In `/admin` > Accounts press **One-time code** on that post office (or **New password**). Tell the code or password to the post office by phone. A code works once and expires after 24 hours.
4. The post office opens Post Office Login, types its PIN, chooses Forgot password, enters the 8-digit code and a new password. Their old logins end.
5. Ask them to add a recovery email under Account recovery after they log in, so this does not happen again.
Never give the code by email or message to an address you have not checked. The action is recorded in the activity log.

## Monitoring
- Create a free monitor at uptimerobot.com for `https://YOUR-SITE.onrender.com/health` every 5 minutes. It alerts you by email if the site is down and also keeps the free Render plan awake, so visitors rarely meet a slow first load.
- On Render, turn on notifications for failed deploys.

## Backups and recovery
- Weekly: open `/admin` and choose "Download a backup". Store it somewhere private (it holds password hashes and locked keys).
- Restore: in the Upstash console open the database, Data Browser, and set the key `sfax:db` to the contents of the backup file. Redeploy the service.
- Your offline master key (`escrow-master-PRIVATE.json`) is separate: keep two copies. Without it lost post office keys cannot be recovered.
- Upstash can also keep its own automatic daily backups on its paid plans.

## If something breaks (disaster recovery)
1. Site down: check Render Logs and the Events tab. Roll back with "Rollback" on the last working deploy.
2. Database lost or damaged: restore the latest backup as above.
3. Master key lost: new post office keys can still be made, but old lost keys cannot be recovered.
4. Suspected leak of `SESSION_SECRET` or `ADMIN_TOKEN`: set new values on Render. Everyone has to log in again. Messages still waiting for an app can no longer be opened after a `SESSION_SECRET` change, so ask senders to resend them.

## Updating
- Website: upload changed files to GitHub. Render redeploys by itself. Check the Logs say "SFAX running".
- Print app: change the version in `package.json`, build, publish a new GitHub release with the three files. Installed apps update themselves. Raise `MIN_APP_VERSION` only when old versions must stop working.
- Run `npm test` (needs Node.js 18+) before uploading website changes.

## Limits you should know (scale)
The whole database is one stored value that is rewritten on each change, on a single server. That is fine for a pilot with tens of post offices and thousands of messages, and it keeps costs near zero. For many thousands of users, move to a real database (for example PostgreSQL) and more than one server. Rate limits and the cleanup job are built in. There is no load balancer, analytics beyond `/admin`, or multi-office management console yet.

## Handling by post offices (suggested procedures)
- Wrong or damaged printout: print again from the app (available for 30 days after printing). Shred the faulty copy.
- Paper out or jam: the message stays "To print"; fix and press Print again.
- Power cut: the same. A message is marked Printed only after the printer accepted the job.
- Unavailable post office: the sender can cancel and send to another post office.
