/**
 * One-time script to get Google Drive OAuth2 refresh token.
 *
 * Usage:
 *   node scripts/get-drive-token.js
 *
 * Reads credentials from: client_secret_desktop.json (server root)
 * When done, copy the 3 lines printed to your .env file.
 */

const { google } = require('googleapis')
const http = require('http')
const path = require('path')
const { exec } = require('child_process')

const credsPath = path.join(__dirname, '..', 'client_secret_desktop.json')
const creds = require(credsPath).installed

const oauth2Client = new google.auth.OAuth2(
  creds.client_id,
  creds.client_secret,
  'http://localhost:4242'
)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive'],
  prompt: 'consent',
})

// Open browser automatically
const openBrowser = (url) => {
  const cmd = process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(cmd)
}

console.log('\n🚀  פותח דפדפן — היכנס עם guesticoniq@gmail.com ואשר גישה...\n')
openBrowser(authUrl)

// Temporary local server to capture the redirect code
const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, 'http://localhost:4242').searchParams.get('code')
  if (!code) {
    res.writeHead(400)
    res.end('Missing code')
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">✅ אושר! אפשר לסגור את הטאב הזה.</h2>')

  server.close()

  try {
    const { tokens } = await oauth2Client.getToken(code)

    console.log('✅  הצלחה! הוסף את השורות הבאות ל-.env:\n')
    console.log(`GOOGLE_CLIENT_ID=${creds.client_id}`)
    console.log(`GOOGLE_CLIENT_SECRET=${creds.client_secret}`)
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log()

    if (!tokens.refresh_token) {
      console.warn('⚠️  לא התקבל refresh_token.')
      console.warn('   בטל גישה קודמת ב: https://myaccount.google.com/permissions ואז הרץ שוב.')
    }
  } catch (err) {
    console.error('❌  שגיאה בהחלפת הקוד:', err.message)
  }
})

server.listen(4242, () => {
  console.log('⏳  ממתין לאישור בדפדפן...')
})
