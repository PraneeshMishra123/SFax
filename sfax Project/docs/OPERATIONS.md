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

## Login code by email for senders and post offices
After login, the gear button (Account security) lets a sender or post office turn on a 6-digit emailed code for every website login. The Print app is exempt (its protection is the key stored on that computer), so turning this on never breaks printing.

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
