const { google } = require('googleapis');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMime({ fromName, fromEmail, to, bcc, subject, html }) {
  const headers = [];
  headers.push(`From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`);
  headers.push(`To: ${to.join(', ')}`);
  if (bcc && bcc.length) headers.push(`Bcc: ${bcc.join(', ')}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/html; charset=UTF-8');
  headers.push(`Subject: ${subject}`);
  const message = headers.join('\r\n') + '\r\n\r\n' + html;
  return base64url(message);
}

function getOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'https://developers.google.com/oauthplayground';
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Gmail OAuth env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN');
  }
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

async function sendEmail({ fromName, fromEmail, to, bcc, subject, html }) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildMime({ fromName, fromEmail, to, bcc, subject, html });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return res.data;
}

module.exports = { sendEmail };

