/**
 * IRIS API Verification Script
 * usage: node verify_iris.js
 * 
 * Prerequisites:
 * 1. Ensure backend is running (npm run dev) on localhost:4000
 * 2. Ensure IRIS_API_KEY is set in .env (or matches the default below if using this script for dev)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:4000/api/iris';
const API_KEY = process.env.IRIS_API_KEY || 'test-key';

async function testEndpoint(name, url, method = 'GET', headers = {}) {
    try {
        const start = Date.now();
        const response = await axios({
            method,
            url,
            headers,
            validateStatus: () => true // Don't throw on error status
        });
        const duration = Date.now() - start;

        console.log(`[${name}] Status: ${response.status} (${duration}ms)`);
        if (response.status === 200) {
            console.log(`   ✅ Success`);
            // console.log('   Response:', JSON.stringify(response.data, null, 2).substring(0, 100) + '...');
        } else {
            console.log(`   ❌ Failed: ${response.data.error || response.statusText}`);
        }
        return response;
    } catch (error) {
        console.log(`[${name}] ❌ Network Error: ${error.message}`);
        return null;
    }
}

async function runTests() {
    console.log('🔍 Starting IRIS API Verification...');
    console.log('-----------------------------------');

    // 1. Test Auth (Missing Key)
    await testEndpoint('Auth: Missing Key', `${BASE_URL}/system-health`, 'GET', {});

    // 2. Test Auth (Invalid Key)
    await testEndpoint('Auth: Invalid Key', `${BASE_URL}/system-health`, 'GET', { 'X-IRIS-API-KEY': 'wrong-key' });

    const authHeaders = { 'X-IRIS-API-KEY': API_KEY };

    // 3. Test System Health
    const health = await testEndpoint('System Health', `${BASE_URL}/system-health`, 'GET', authHeaders);
    if (health?.data?.status === 'healthy') console.log('   -> Data Integrity: OK');

    // 4. Test AI Agents
    const agents = await testEndpoint('AI Agents', `${BASE_URL}/ai-agents`, 'GET', authHeaders);
    if (agents?.data?.agents) console.log(`   -> Agents Found: ${agents.data.agents.length}`);

    // 5. Test Growth Metrics
    const metrics = await testEndpoint('Growth Metrics', `${BASE_URL}/growth-metrics`, 'GET', authHeaders);
    if (metrics?.data?.total_users !== undefined) console.log(`   -> Users Count: ${metrics.data.total_users}`);

    // 6. Test Security Stats
    await testEndpoint('Security Stats', `${BASE_URL}/security`, 'GET', authHeaders);

    // 7. Test Rate Limiting
    console.log('\nTesting Rate Limiting (Sending 2 requests quickly)...');
    await testEndpoint('Request 1', `${BASE_URL}/system-health`, 'GET', authHeaders);
    const rateLimit = await testEndpoint('Request 2', `${BASE_URL}/system-health`, 'GET', authHeaders);

    if (rateLimit?.status === 429) {
        console.log('   ✅ Rate Limit Enforced (429 Too Many Requests)');
    } else {
        console.log('   ⚠️ Rate Limit Not Triggered (Check configuration)');
    }

    console.log('\n-----------------------------------');
    console.log('Verification Complete.');
}

runTests();
