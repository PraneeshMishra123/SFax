# Status of the website review points

## Done in this version (website and server)
- Clearer value proposition, a stronger first screen and a journey diagram; first-time-user guide; detailed FAQ in groups; visible navigation on every screen size.
- Tracking explained (status table), delivery timing stated honestly, notification email when printed, failed-delivery and cancellation steps, how to correct wrong details.
- Pricing: nothing is charged by the site, so no pricing page was invented. Add one if you introduce fees.
- Policies: privacy, terms, retention and deletion on the page; encryption, key generation, key protection and the website-to-app channel explained; "no independent audit yet" stated plainly.
- Sending: progress text, success message, field-by-field checks, character counter, limits shown, double-submit protection (button lock and duplicate recognition), draft kept after a refresh, session kept after a refresh, Back button works, session-expiry message, friendly server-down and slow-start messages, warning for letters that will print as "?".
- Accounts: forgot password with an emailed 6-digit code (10 minutes, single use, 5 tries), 8-character minimum, old logins ended after a reset, recovery email for post offices.
- Security: rate limits on login, sign-up, code requests and sending; security headers; each request checked against the signed-in account; automated tests for access control; activity log without message text; no passwords or message text in logs.
- Data: automatic deletion of old messages (30 days after printing, 90 if never printed); cancel before printing; backup download.
- Admin: dashboard with totals, post offices, app installed or not, pending prints, settings check, recent activity.
- Accessibility basics: skip link, visible focus, keyboard-reachable links, labelled fields, announced errors, reduced-motion support, status shown in words as well as colour.
- Performance: compressed page, no images or external scripts, wake-up ping on load.
- "A minor project" wording removed.

## Added in the latest round
- Messages up to 10,000 characters. A long message prints on as many sheets as it needs; the address sheet is still first and the blank sheet still last.
- Post office forgot password with no email: the owner issues a one-time 8-digit code from `/admin` after checking identity. Post offices can also add or change a recovery email after logging in (password confirmed).
- Print app 1.0.2: shows every printer, ticks the dot matrix ones and allows only those; identifies them from IEEE 1284 and USB details read from Windows and from a model database (`lib/models.json`); shows printer status (offline, out of paper, jam where Windows reports it); separate To print and Printed lists; offline notice.

## Written up in docs/OPERATIONS.md
Settings, email setup, monitoring and downtime alerts, backups and restore, disaster recovery, updates, scale limits, and suggested post office procedures (damaged printouts, paper and jams, power cuts, unavailable post offices).

## Needs your input (code cannot decide these)
Your organisation name, About text, address and support contact (set the SUPPORT_ and ORG_ settings); a legal review of the privacy policy and terms; any pricing or fees; delivery-time promises; which printer models you officially support; returned-letter and shift procedures; an independent security audit.

## Not done yet
- Print app: an error log file and shift or queue priority.
- Backup post office assignment, a multi-office console and analytics beyond the admin page.
- Load balancing and a larger database (see "Limits" in the operations guide).
- Testing in many browsers, with screen readers, colour-contrast tools and many simultaneous users: these need real devices and tools.
