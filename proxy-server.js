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

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'Proxy running', 
        timestamp: new Date(),
        connected: !!accessToken,
        endpoints: [
            'POST /api/sync',
            'GET /api/user',
            'GET /api/users',
            'GET /api/analytics',
            'PUT /api/user/:id',
            'DELETE /api/user/:id'
        ]
    });
});

// ========== SYNC USER (from App) ==========
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

// ========== GET SINGLE USER ==========
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

// ========== GET ALL USERS (Admin) ==========
app.get('/api/users', ensureToken, async (req, res) => {
    try {
        // Query all StreakHabit users from Salesforce
        const soql = `SELECT Id, Name, Email, StreakHabit_Username__c, StreakHabit_XP__c, 
                      StreakHabit_Streak__c, StreakHabit_Friends__c, StreakHabit_Usage__c,
                      StreakHabit_Avatar__c, CreatedDate 
                      FROM Contact 
                      WHERE StreakHabit_Username__c != null 
                      ORDER BY StreakHabit_XP__c DESC`;

        const response = await axios.get(
            `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(soql)}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            status: 'success',
            total: response.data.totalSize,
            users: response.data.records.map(record => ({
                id: record.Id,
                name: record.Name,
                email: record.Email,
                username: record.StreakHabit_Username__c,
                xp: record.StreakHabit_XP__c || 0,
                streak: record.StreakHabit_Streak__c || 0,
                friends: record.StreakHabit_Friends__c || 0,
                usage: record.StreakHabit_Usage__c || 0,
                avatar: record.StreakHabit_Avatar__c || '🦉',
                createdAt: record.CreatedDate
            }))
        });
    } catch (error) {
        console.error('Get users error:', error.response?.data || error.message);
        res.status(500).json({
            status: 'error',
            message: error.response?.data?.[0]?.message || error.message
        });
    }
});

// ========== GET ANALYTICS (Admin) ==========
app.get('/api/analytics', ensureToken, async (req, res) => {
    try {
        // Total users
        const usersQuery = `SELECT COUNT(Id) totalUsers FROM Contact WHERE StreakHabit_Username__c != null`;
        const usersRes = await axios.get(
            `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(usersQuery)}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );

        // Total streaks
        const streaksQuery = `SELECT SUM(StreakHabit_Streak__c) totalStreaks FROM Contact WHERE StreakHabit_Username__c != null`;
        const streaksRes = await axios.get(
            `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(streaksQuery)}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );

        // Total completions (usage)
        const usageQuery = `SELECT SUM(StreakHabit_Usage__c) totalUsage FROM Contact WHERE StreakHabit_Username__c != null`;
        const usageRes = await axios.get(
            `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(usageQuery)}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );

        // Total friends
        const friendsQuery = `SELECT SUM(StreakHabit_Friends__c) totalFriends FROM Contact WHERE StreakHabit_Username__c != null`;
        const friendsRes = await axios.get(
            `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(friendsQuery)}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );

        res.json({
            status: 'success',
            analytics: {
                totalUsers: usersRes.data.records[0].totalUsers || 0,
                totalStreaks: streaksRes.data.records[0].totalStreaks || 0,
                totalCompletions: usageRes.data.records[0].totalUsage || 0,
                totalFriends: friendsRes.data.records[0].totalFriends || 0
            }
        });
    } catch (error) {
        console.error('Analytics error:', error.response?.data || error.message);
        res.status(500).json({
            status: 'error',
            message: error.response?.data?.[0]?.message || error.message
        });
    }
});

// ========== UPDATE USER (Admin) ==========
app.put('/api/user/:id', ensureToken, async (req, res) => {
    try {
        const userId = req.params.id;
        const updates = req.body;

        const response = await axios.patch(
            `${instanceUrl}/services/data/v58.0/sobjects/Contact/${userId}`,
            updates,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            status: 'success',
            message: 'User updated',
            id: response.data.id
        });
    } catch (error) {
        console.error('Update error:', error.response?.data || error.message);
        res.status(500).json({
            status: 'error',
            message: error.response?.data?.[0]?.message || error.message
        });
    }
});

// ========== DELETE USER (Admin) ==========
app.delete('/api/user/:id', ensureToken, async (req, res) => {
    try {
        const userId = req.params.id;

        await axios.delete(
            `${instanceUrl}/services/data/v58.0/sobjects/Contact/${userId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            status: 'success',
            message: 'User deleted'
        });
    } catch (error) {
        console.error('Delete error:', error.response?.data || error.message);
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
    console.log(`🔧 Admin endpoints ready:`);
    console.log(`   GET  /api/users     - List all users`);
    console.log(`   GET  /api/analytics  - Get totals`);
    console.log(`   PUT  /api/user/:id   - Update user`);
    console.log(`   DELETE /api/user/:id - Delete user`);
});
