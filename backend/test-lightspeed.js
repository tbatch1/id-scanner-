// Quick test script to verify Lightspeed API connection
require('dotenv').config();
const axios = require('axios');

const PERSONAL_TOKEN = process.env.LIGHTSPEED_API_KEY;
const DOMAIN_PREFIX = process.env.LIGHTSPEED_DOMAIN_PREFIX || process.env.LIGHTSPEED_ACCOUNT_ID;
const BASE_URL = `https://${DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0`;

console.log('\n🔍 Testing Lightspeed API Connection...\n');
console.log('Base URL:', BASE_URL);
console.log('Token:', PERSONAL_TOKEN ? `${PERSONAL_TOKEN.substring(0, 15)}...` : 'MISSING');
console.log('\n---\n');

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${PERSONAL_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

async function testConnection() {
  try {
    console.log('✅ TEST 1: Fetching outlets...');
    const outletsResponse = await api.get('/outlets');
    console.log(`   Found ${outletsResponse.data.data.length} outlets`);
    outletsResponse.data.data.forEach(outlet => {
      console.log(`   - ${outlet.name} (ID: ${outlet.id})`);
    });
    console.log('');

    console.log('✅ TEST 2: Fetching recent sales...');
    const salesResponse = await api.get('/sales', {
      params: { page_size: 5 }
    });
    console.log(`   Found ${salesResponse.data.data.length} recent sales`);
    salesResponse.data.data.forEach(sale => {
      console.log(`   - Sale ${sale.id}: $${sale.total_price} (${sale.status})`);
    });
    console.log('');

    console.log('✅ TEST 3: Fetching customers...');
    const customersResponse = await api.get('/customers', {
      params: { page_size: 3 }
    });
    console.log(`   Found ${customersResponse.data.data.length} customers`);
    console.log('');

    console.log('🎉 ALL TESTS PASSED! Lightspeed API is working!\n');
    return true;

  } catch (error) {
    console.error('❌ TEST FAILED!');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    }
    console.log('');
    return false;
  }
}

testConnection().then(success => {
  process.exit(success ? 0 : 1);
});
