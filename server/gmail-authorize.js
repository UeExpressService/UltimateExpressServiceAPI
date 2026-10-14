const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { google } = require('googleapis');

const credentialsPath = process.argv[2];
const requestedPort = process.argv[3] || process.env.GMAIL_AUTH_PORT;
const requestedSenderEmail = process.argv[4];
if (!credentialsPath) {
    console.error('Usage: npm run gmail:authorize -- "C:\\path\\to\\client_secret.json" [port] [sender-email]');
    process.exit(1);
}

let credentials;
try {
    credentials = JSON.parse(fs.readFileSync(path.resolve(credentialsPath), 'utf8'));
} catch (error) {
    console.error(`Unable to read OAuth JSON: ${error.message}`);
    process.exit(1);
}

const installed = credentials.installed || credentials.web;
if (!installed || !installed.client_id || !installed.client_secret) {
    console.error('The JSON must be a Google OAuth Desktop/Web client file.');
    process.exit(1);
}

const server = http.createServer();
const DEFAULT_PORT = 58040;
const portToUse = parseInt(requestedPort || DEFAULT_PORT, 10);

server.listen(portToUse, '127.0.0.1', async () => {
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/gmail.send']
    });

    console.log('\nOpen this URL in your browser and approve Gmail access:\n');
    console.log(authUrl);
    console.log(`\nWaiting for Google callback on ${redirectUri}...`);
});

server.on('request', async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname !== '/oauth2callback') {
        response.writeHead(404);
        response.end();
        return;
    }

    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<h2>Authorization received. You can close this tab.</h2>');

    if (error || !code) {
        console.error(`Google authorization failed: ${error || 'no authorization code'}`);
        server.close(() => process.exit(1));
        return;
    }

    try {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.refresh_token) {
            throw new Error('No refresh token returned. Revoke the app access and run this command again.');
        }

        const email = await getSenderEmail();
        updateEnvFile({
            GMAIL_USER: email,
            GMAIL_CLIENT_ID: installed.client_id,
            GMAIL_CLIENT_SECRET: installed.client_secret,
            GMAIL_REFRESH_TOKEN: tokens.refresh_token
        });
        console.log(`Gmail OAuth settings saved to ${path.resolve('.env')}.`);
        server.close(() => process.exit(0));
    } catch (tokenError) {
        console.error(`Unable to finish Gmail authorization: ${tokenError.message}`);
        server.close(() => process.exit(1));
    }
});

async function getSenderEmail() {
    const email = requestedSenderEmail || process.env.GMAIL_USER || '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;

    const prompt = readline.createInterface({ input: stdin, output: stdout });
    try {
        while (true) {
            const answer = await prompt.question('Enter the Gmail address authorized to send mail: ');
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer.trim())) return answer.trim();
            console.log('Enter a valid email address.');
        }
    } finally {
        prompt.close();
    }
}

function updateEnvFile(values) {
    const envPath = path.resolve('.env');
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    let updated = existing;
    for (const [key, value] of Object.entries(values)) {
        const line = `${key}=${value}`;
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        updated = pattern.test(updated) ? updated.replace(pattern, line) : `${updated.trimEnd()}\n${line}\n`;
    }
    fs.writeFileSync(envPath, updated);
}
