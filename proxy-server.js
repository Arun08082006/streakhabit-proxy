const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Salesforce OAuth config
const SF_CONFIG = {
    loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    username: process.env.SF_USERNAME,
    password: process.env.SF_PASSWORD + (process.env.SF_SECURITY_TOKEN || '')
};

let accessToken = null;
let instanceUrl = null;
let tokenExpiry = null;

// Get Salesforce access token
async function getAccessToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('client_id', SF_CONFIG.clientId);
    params.append('client_secret', SF_CONFIG.clientSecret);
    params.append('username', SF_CONFIG.username);
    params.append('password', SF_CONFIG.password);

    const response = await axios.post(`${SF_CONFIG.loginUrl}/services/oauth2/token`, params);
    accessToken = response.data.access_token;
    instanceUrl = response.data.instance_url;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    return accessToken;
}

// Middleware to ensure valid token
async function ensureToken(req, res, next) {
    try {
        if (!accessToken || !tokenExpiry || Date.now() >= tokenExpiry - 60000) {
            await getAccessToken();
        }
        next();
    } catch (error) {
        console.error('Token error:', error.message);
        res.status(500).json({ status: 'error', message: 'Authentication failed' });
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'Proxy running', 
        timestamp: new Date(),
        connected: !!accessToken 
    });
});

// Sync user to Salesforce
app.post('/api/sync', ensureToken, async (req, res) => {
    try {
        const response = await axios.post(
            `${instanceUrl}/services/apexrest/streakhabit/v1/syncUser`,
            req.body,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json(response.data);

    } catch (error) {
        console.error('Sync error:', error.response?.data || error.message);
        res.status(500).json({
            status: 'error',
            message: error.response?.data?.[0]?.message || error.message
        });
    }
});

// Get user from Salesforce
app.get('/api/user', ensureToken, async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).json({ status: 'error', message: 'Email required' });
        }

        const response = await axios.get(
            `${instanceUrl}/services/apexrest/streakhabit/v1/getUser?email=${encodeURIComponent(email)}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json(response.data);

    } catch (error) {
        console.error('Get user error:', error.response?.data || error.message);
        res.status(500).json({
            status: 'error',
            message: error.response?.data?.[0]?.message || error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ StreakHabit Proxy Server running on port ${PORT}`);
    console.log(`📡 Salesforce Instance: ${SF_CONFIG.loginUrl}`);
});
