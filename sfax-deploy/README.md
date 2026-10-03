# SFAX – Message your nearest post office

## Run
1. Install Node.js (v16 or newer) from https://nodejs.org
2. In this folder run:  node server.js
3. Open http://localhost:3000

No `npm install` is needed (only built-in Node modules are used).

## Use from other computers
- Same Wi-Fi/LAN: find the server computer's IP address (e.g. 192.168.1.20) and open
  http://192.168.1.20:3000 on the other computers. Allow port 3000 in the firewall.
- Over the internet: deploy this folder to a Node host (Render, Railway, etc.).

## Dot matrix printing without preview (post office computer)
Set the dot matrix printer as the default printer, then start Chrome/Edge with:
  chrome.exe --kiosk-printing http://<server-ip>:3000

## Files
- server.js          backend (API, login, storage in data.json)
- public/index.html  the website
