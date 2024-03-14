const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fetch = require('node-fetch');
const crypto = require('crypto'); // Token oluşturmak için
const { promisify } = require('util');
const moment = require('moment-timezone');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

let clientsData = {};
let blockedClients = {};

app.use(express.json());
app.use(express.static('public')); // Statik dosyaları sunmak için

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1146109777387208857/xFh8hWNAy-oOfHIBJdpf-dm3-v1SpD9OoghWcPHv9L6WP-jvEDjGmYoVpFYh5Z6bV1qm'; // Discord webhook URL'nizi buraya ekleyin

function xorEncryptDecrypt(input, key) {
    const inputBuffer = Buffer.from(input);
    const keyBuffer = Buffer.from(key);
    const outputBuffer = Buffer.alloc(inputBuffer.length);

    for (let i = 0; i < inputBuffer.length; i++) {
        outputBuffer[i] = inputBuffer[i] ^ keyBuffer[i % keyBuffer.length];
    }

    return outputBuffer.toString();
}

function encryptJson(key, data) {
    const jsonStr = JSON.stringify(data);
    return xorEncryptDecrypt(jsonStr, key);
}

function decryptJson(key, encryptedData) {
    const decryptedStr = xorEncryptDecrypt(encryptedData, key);
    return JSON.parse(decryptedStr);
}

// Örnek kullanım
const key = "\\1V8yFSkXe32X2vz=0#eM>h1ueF.kKJJ";

app.use(async (req, res, next) => {
    const allowedIPs = ["95.10.185.158", "31.206.196.123"]; // İzin verilen IP adresleri
    let clientIP = req.socket.remoteAddress;

    // IPv6 formatındaki IPv4 adresini kontrol et ve dönüştür
    if (clientIP.substr(0, 7) === "::ffff:") {
        clientIP = clientIP.substr(7);
    }

    if (!allowedIPs.includes(clientIP)) {
        // IP adresi bilgisini al
        const ipInfoResponse = await fetch(`https://ipinfo.io/${clientIP}/json`);
        const ipInfo = await ipInfoResponse.json();

        // Discord'a mesaj gönder
        const discordMessage = {
            content: `Erişim Reddedildi\n IP: ${clientIP}\nÜlke: ${ipInfo.country}\nŞehir: ${ipInfo.city}`
        };

        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordMessage)
        });
        res.status(403).send(".");
    } else {
        next();
    }
});

wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        const data = decryptJson(key, message);

        if (data.key) {
            try {
                const response = await fetch(`https://keyauth.win/api/seller/?sellerkey=db16a6263e84dbead18e6d50d7f38f66&type=info&key=${data.key}`, {
                    method: 'GET',
                    headers: { 'User-Agent': 'application' }
                });
                const responseData = await response.json();

                if (responseData.success) {
                    console.log('Key validated successfully.');

                    const expireTime = data.expire;
                    const currentTime = moment().tz(data.timezone);

                    console.log(expireTime)

                    if (currentTime.isAfter(expireTime)) {
                        console.log('Key expired. Closing connection.');
                        ws.close(4001, "Key expired");
                    } else {
                        ws.key = data.key;
                        clientsData[data.key] = { ...data, ws, status: 'Logined' };
                        console.log('Received data:', data);
                    }
                } else {
                    console.log('Key validation failed. Closing connection.');
                    ws.close(4001, "Invalid key");
                }
            } catch (error) {
                console.error('Error verifying key with KeyAuth:', error);
                ws.close(4001, "Error during key verification");
            }
        } else {
            console.log('Invalid user data received, ignored.');
        }
    });

    ws.on('close', () => {
        if (ws.key && clientsData[ws.key]) {
            clientsData[ws.key].open = false;
            if (clientsData[ws.key].status === 'Logined') {
                clientsData[ws.key].status = 'Exited';
            }
        }
    });
});

app.post('/action', (req, res) => {
    const { action, key } = req.body;
    const client = clientsData[key];
    switch (action) {
        case 'kick':
            if (client && client.ws) {
                client.ws.terminate(); // WebSocket bağlantısını kes
                client.status = 'kicked'; // Durumu güncelle
            }
            break;
        case 'block':
            blockedClients[key] = true;
            if (client && client.ws) {
                client.ws.terminate(); // WebSocket bağlantısını kes
                client.status = 'blocked'; // Durumu güncelle
            }
            break;
        case 'unlock':
            delete blockedClients[key];
            if (client) {
                client.status = 'unblocked'; // Durumu güncelle
            }
            break;
        default:
            return res.status(400).send({ message: "Invalid action" });
    }
    res.json({ success: true, action, key });
});

// Expire kontrolü ve kullanıcı atma
setInterval(() => {
    Object.keys(clientsData).forEach(key => {
        const client = clientsData[key];
        if (client.status === 'Logined') {
            const expireTime = moment(client.expire);
            const currentTime = moment().tz(client.timezone);

            if (currentTime.isAfter(expireTime)) {
                console.log(`Key ${key} expired. Kicking user.`);
                client.ws.close(4001, "Key expired");
                client.status = 'Expired';
            }
        }
    });
}, 30000); // Her 30 saniyede bir kontrol et

app.get('/', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 10;
    const total = Object.keys(clientsData).length;
    const totalPages = Math.ceil(total / pageSize);
    const paginatedKeys = Object.keys(clientsData).slice((page - 1) * pageSize, page * pageSize);

    let paginationHTML = '';
    for (let i = 1; i <= totalPages; i++) {
        paginationHTML += `<a href="/?page=${i}" class="px-4 py-2 ${i === page ? 'bg-blue-500' : 'bg-gray-300'} rounded-full mx-1">${i}</a>`;
    }

    const clientsHTML = paginatedKeys.map(key => {
        const client = clientsData[key];
        // Tüm değerlerin tanımlı olduğundan emin ol
        const dropdownId = `dropdownInformation${client.key}`; // Benzersiz ID oluştur
        if (client && client.key && client.country && client.city && client.ip && client.expire && client.subscription && client.pc_name && client.exe_name && client.status && typeof client.open !== 'undefined') {
            return `
                <tr>
                    <td class="px-4 py-3">${client.key}</td>
                    <td class="px-4 py-3">${client.country}</td>
                    <td class="px-4 py-3">${client.city}</td>
                    <td class="px-4 py-3">${client.ip}</td>
                    <td class="px-4 py-3">${client.open ? 'Yes' : 'No'}</td>
                    <td class="px-4 py-3">${client.status}</td>
                    <td class="px-4 py-3">
                        <button onclick="sendAction('${client.key}', 'kick')" class="px-2 py-1 bg-red-200 text-red-800 rounded">Kick</button>
                        <button onclick="sendAction('${client.key}', 'block')" class="px-2 py-1 bg-red-500 text-white rounded">Block</button>
                        <button onclick="sendAction('${client.key}', 'unlock')" class="px-2 py-1 bg-green-500 text-white rounded">Unlock</button>
                    </td>
                    <td class="px-4 py-3">
                        <button id="dropdownInformationButton${client.key}" data-dropdown-toggle="${dropdownId}" class="text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center inline-flex items-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800" type="button">Information   <svg class="w-2.5 h-2.5 ms-3" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 10 6">
                        <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m1 1 4 4 4-4"/>
                        </svg>
                        </button>
                        <div id="${dropdownId}" class="z-10 hidden bg-white divide-y divide-gray-100 rounded-lg shadow w-44 dark:bg-gray-700 dark:divide-gray-600">
                            <div class="px-4 py-3 text-sm text-gray-900 dark:text-white">
                                <div class="ms-2 text-sm">
                                    <label for="helper-checkbox-1" class="font-medium text-gray-900 dark:text-gray-300">
                                        <div><b>PC Name</b></div>
                                        <p id="helper-checkbox-text-1" class="text-xs font-normal text-gray-500 dark:text-gray-300">${client.pc_name}</p>
                                    </label>
                                    <label for="helper-checkbox-1" class="font-medium text-gray-900 dark:text-gray-300">
                                        <div><b>Subscription</b></div>
                                        <p id="helper-checkbox-text-1" class="text-xs font-normal text-gray-500 dark:text-gray-300">${client.subscription}</p>
                                    </label>
                                    <label for="helper-checkbox-1" class="font-medium text-gray-900 dark:text-gray-300">
                                        <div><b>Expire</b></div>
                                        <p id="helper-checkbox-text-1" class="text-xs font-normal text-gray-500 dark:text-gray-300">${client.expire}</p>
                                    </label>
                                    <label for="helper-checkbox-1" class="font-medium text-gray-900 dark:text-gray-300">
                                        <div><b>EXE Name</b></div>
                                        <p id="helper-checkbox-text-1" class="text-xs font-normal text-gray-500 dark:text-gray-300">${client.exe_name}</p>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </td>
                </tr>
                
            `;
        } else {
            // Eğer bir değer undefined ise bu kullanıcıyı atla
            return '';
        }
    }).join('');

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connected Clients</title>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/flowbite/2.3.0/flowbite.min.css" rel="stylesheet" />
    <script src="https://cdnjs.cloudflare.com/ajax/libs/flowbite/2.3.0/flowbite.min.js"></script>
</head>
<body class="bg-gray-900">
    <div class="min-h-screen flex flex-col justify-center items-center">
        <h2 class="text-xl font-semibold text-gray-300 mb-4">Connected Clients (${Object.keys(clientsData).length})</h2>
        <div class="w-full max-w-6xl p-4 bg-white rounded-lg shadow">
            <table class="table-auto w-full text-left whitespace-no-wrap">
                <thead>
                    <tr class="text-xs font-semibold tracking-wide text-left text-gray-500 uppercase border-b bg-gray-50 rounded-t-lg">
                    <th class="px-4 py-3 rounded-l-lg">Key</th>
                        <th class="px-4 py-3">Country</th>
                        <th class="px-4 py-3">City</th>
                        <th class="px-4 py-3">IP</th>
                        <th class="px-4 py-3">Open</th>
                        <th class="px-4 py-3">Status</th>
                        <th class="px-4 py-3">Actions</th>
                    </tr>
                </thead>
                <tbody class="bg-white divide-y">
                    ${clientsHTML}
                </tbody>
            </table>
            <div class="flex justify-center mt-4">
                ${paginationHTML}
            </div>
        </div>
    </div>
    <script>
        async function sendAction(key, action) {
            await fetch('/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, action })
            });
            window.location.reload();
        }
    </script>
</body>
</html>
    `);
});

server.listen(5802, () => {
    console.log('Server listening on port 5802');
});
