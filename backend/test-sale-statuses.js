require('dotenv').config();
const axios = require('axios');

const PERSONAL_TOKEN = process.env.LIGHTSPEED_API_KEY;
const DOMAIN_PREFIX = process.env.LIGHTSPEED_DOMAIN_PREFIX || process.env.LIGHTSPEED_ACCOUNT_ID;
const BASE_URL = `https://${DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0`;

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${PERSONAL_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

async function testSaleStatuses() {
  console.log('\n🔍 Testing Lightspeed Sale Statuses...\n');

  try {
    // Test 1: Get open sales
    console.log('✅ TEST 1: Fetching OPEN sales...');
    const openSales = await api.get('/sales', {
      params: {
        page_size: 5,
        status: 'OPEN'
      }
    });
    console.log(`   Found ${openSales.data.data?.length || 0} open sales`);
    if (openSales.data.data && openSales.data.data.length > 0) {
      const sale = openSales.data.data[0];
      console.log(`   - Sale ${sale.id}: $${sale.total_price} (${sale.status})`);
      console.log(`   - Has note: ${sale.note || 'none'}`);
      console.log(`   - Created: ${sale.created_at}`);
    }

    // Test 2: Check if we can see parked/held sales
    console.log('\n✅ TEST 2: Checking for PARKED/HELD sales...');
    try {
      const parkedSales = await api.get('/sales', {
        params: {
          page_size: 5,
          status: 'PARKED'
        }
      });
      console.log(`   Found ${parkedSales.data.data?.length || 0} parked sales`);
    } catch (err) {
      console.log(`   PARKED status not supported: ${err.response?.data?.message || err.message}`);
    }

    // Test 3: Get sale statuses documentation
    console.log('\n✅ TEST 3: Available sale fields...');
    if (openSales.data.data && openSales.data.data.length > 0) {
      const sale = openSales.data.data[0];
      console.log('   Sale object keys:', Object.keys(sale).join(', '));
    }

    console.log('\n🎉 Status tests complete!\n');

  } catch (error) {
    console.error('\n❌ Test failed!');
    console.error('Error:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

testSaleStatuses();
