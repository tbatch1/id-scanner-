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

async function getParkedSale() {
  console.log('\n🔍 Fetching your parked sale...\n');

  try {
    // Get ALL recent sales from warehouse (no status filter)
    const warehouseOutletId = '02f4a1bc-ae66-11f0-f174-8d8eeff9231e';

    console.log('Checking ALL recent sales (warehouse outlet)...');
    const allSalesResponse = await api.get('/sales', {
      params: {
        page_size: 50,
        outlet_id: warehouseOutletId,
        order: 'created_at DESC'
      }
    });

    const sales = allSalesResponse.data.data || [];

    if (sales.length === 0) {
      console.log('❌ No open or parked sales found. Try creating one in the POS.');
      return;
    }

    console.log(`✅ Found ${sales.length} recent sale(s):\n`);

    sales.forEach((sale, index) => {
      console.log(`📦 Sale #${index + 1}:`);
      console.log(`   Sale ID: ${sale.id}`);
      console.log(`   Status: ${sale.status}`);
      console.log(`   Total: $${sale.total_price}`);
      console.log(`   Outlet ID: ${sale.outlet_id}`);
      console.log(`   Created: ${new Date(sale.created_at).toLocaleString()}`);
      console.log(`   Note: ${sale.note || 'none'}`);
      console.log('');
    });

    // Show the most recent one
    const mostRecent = sales[0];
    console.log('🎯 MOST RECENT PARKED SALE:');
    console.log(`   Sale ID: ${mostRecent.id}`);
    console.log(`   Use this for testing!`);
    console.log('');

  } catch (error) {
    console.error('❌ Error fetching parked sales:');
    console.error('   ', error.response?.data || error.message);
  }
}

getParkedSale();
