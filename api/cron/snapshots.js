// Daily snapshot job - aggregates Lightspeed data into local DB for fast BI queries
// Schedule: 0 5 * * * (5 AM daily)

const lightspeed = require('../../backend/src/lightspeedClient');
const db = require('../../backend/src/db');
const logger = require('../../backend/src/logger');

async function runSnapshotJob() {
  const startTime = Date.now();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const snapshotDate = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD

  logger.info({ event: 'snapshot_job_start', snapshotDate });

  const results = {
    salesSnapshots: 0,
    inventorySnapshots: 0,
    customerSnapshots: 0,
    outletSnapshots: 0,
    errors: []
  };

  try {
    if (!db.pool) {
      throw new Error('Database not available');
    }

    // 1. Fetch outlets for reference
    const outlets = await lightspeed.listOutlets();
    const outletMap = {};
    for (const outlet of outlets) {
      outletMap[outlet.outletId] = outlet;
    }

    // 2. Fetch yesterday's closed sales with line items
    const sales = await lightspeed.listSalesWithLineItems({
      status: 'CLOSED',
      limit: 200,
      dateFrom: snapshotDate,
      dateTo: snapshotDate
    });

    // 3. Aggregate sales by product/outlet
    const salesAgg = {};
    const customerAgg = {};
    const outletAgg = {};

    for (const sale of sales) {
      const outletId = sale.outletId || 'UNKNOWN';
      const outletName = outletMap[outletId]?.name || outletId;
      const customerId = sale.customerId;

      // Initialize outlet aggregate
      if (!outletAgg[outletId]) {
        outletAgg[outletId] = {
          outletId,
          outletName,
          totalRevenue: 0,
          totalTransactions: 0,
          uniqueCustomers: new Set(),
          itemsSold: 0
        };
      }
      outletAgg[outletId].totalRevenue += sale.total || 0;
      outletAgg[outletId].totalTransactions += 1;
      if (customerId) {
        outletAgg[outletId].uniqueCustomers.add(customerId);
      }

      // Aggregate by customer (if known)
      if (customerId) {
        const custKey = `${customerId}|${outletId}`;
        if (!customerAgg[custKey]) {
          customerAgg[custKey] = {
            customerId,
            outletId,
            outletName,
            transactionCount: 0,
            totalSpend: 0
          };
        }
        customerAgg[custKey].transactionCount += 1;
        customerAgg[custKey].totalSpend += sale.total || 0;
      }

      // Aggregate by product
      for (const item of sale.lineItems || []) {
        const productId = item.productId || 'UNKNOWN';
        const key = `${outletId}|${productId}`;

        if (!salesAgg[key]) {
          salesAgg[key] = {
            outletId,
            outletName,
            productId,
            productName: item.productName || 'Unknown Product',
            sku: item.sku || null,
            categoryName: null, // Would need product lookup
            quantitySold: 0,
            revenue: 0,
            transactionCount: 0
          };
        }

        const qty = item.quantity || 0;
        salesAgg[key].quantitySold += qty;
        salesAgg[key].revenue += item.lineTotal || 0;
        salesAgg[key].transactionCount += 1;
        outletAgg[outletId].itemsSold += qty;
      }
    }

    // 4. Insert sales snapshots
    for (const data of Object.values(salesAgg)) {
      try {
        await db.pool.query(`
          INSERT INTO daily_sales_snapshots
            (snapshot_date, outlet_id, outlet_name, product_id, product_name, sku, category_name, quantity_sold, revenue, transaction_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (snapshot_date, outlet_id, product_id)
          DO UPDATE SET
            quantity_sold = EXCLUDED.quantity_sold,
            revenue = EXCLUDED.revenue,
            transaction_count = EXCLUDED.transaction_count,
            outlet_name = EXCLUDED.outlet_name,
            product_name = EXCLUDED.product_name
        `, [
          snapshotDate,
          data.outletId,
          data.outletName,
          data.productId,
          data.productName,
          data.sku,
          data.categoryName,
          data.quantitySold,
          data.revenue,
          data.transactionCount
        ]);
        results.salesSnapshots++;
      } catch (err) {
        results.errors.push(`Sales snapshot error: ${err.message}`);
      }
    }

    // 5. Fetch and insert inventory snapshots
    for (const outlet of outlets) {
      try {
        const inventory = await lightspeed.listInventory({ outletId: outlet.outletId, limit: 200 });

        for (const item of inventory) {
          try {
            const inventoryValue = (item.currentAmount || 0) * (item.averageCost || 0);
            await db.pool.query(`
              INSERT INTO daily_inventory_snapshots
                (snapshot_date, outlet_id, outlet_name, product_id, product_name, sku, current_amount, reorder_point, average_cost, retail_price, inventory_value)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (snapshot_date, outlet_id, product_id)
              DO UPDATE SET
                current_amount = EXCLUDED.current_amount,
                reorder_point = EXCLUDED.reorder_point,
                average_cost = EXCLUDED.average_cost,
                inventory_value = EXCLUDED.inventory_value
            `, [
              snapshotDate,
              outlet.outletId,
              outlet.name,
              item.productId,
              item.productName,
              item.sku,
              item.currentAmount,
              item.reorderPoint,
              item.averageCost,
              item.retailPrice,
              inventoryValue
            ]);
            results.inventorySnapshots++;
          } catch (err) {
            results.errors.push(`Inventory item error: ${err.message}`);
          }
        }
      } catch (err) {
        results.errors.push(`Inventory fetch error for ${outlet.outletId}: ${err.message}`);
      }
    }

    // 6. Insert customer snapshots
    // First, fetch customer names
    const customers = await lightspeed.listCustomers({ limit: 200 });
    const customerMap = {};
    for (const c of customers) {
      customerMap[c.customerId] = c;
    }

    for (const data of Object.values(customerAgg)) {
      try {
        const customer = customerMap[data.customerId] || {};
        const avgValue = data.transactionCount > 0 ? data.totalSpend / data.transactionCount : 0;

        await db.pool.query(`
          INSERT INTO daily_customer_snapshots
            (snapshot_date, customer_id, customer_name, customer_email, outlet_id, outlet_name, transaction_count, total_spend, avg_transaction_value)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (snapshot_date, customer_id, outlet_id)
          DO UPDATE SET
            transaction_count = EXCLUDED.transaction_count,
            total_spend = EXCLUDED.total_spend,
            avg_transaction_value = EXCLUDED.avg_transaction_value
        `, [
          snapshotDate,
          data.customerId,
          customer.name || 'Unknown',
          customer.email || null,
          data.outletId,
          data.outletName,
          data.transactionCount,
          data.totalSpend,
          avgValue
        ]);
        results.customerSnapshots++;
      } catch (err) {
        results.errors.push(`Customer snapshot error: ${err.message}`);
      }
    }

    // 7. Insert outlet summary snapshots
    for (const data of Object.values(outletAgg)) {
      try {
        const avgValue = data.totalTransactions > 0 ? data.totalRevenue / data.totalTransactions : 0;

        await db.pool.query(`
          INSERT INTO daily_outlet_snapshots
            (snapshot_date, outlet_id, outlet_name, total_revenue, total_transactions, avg_transaction_value, unique_customers, items_sold)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (snapshot_date, outlet_id)
          DO UPDATE SET
            total_revenue = EXCLUDED.total_revenue,
            total_transactions = EXCLUDED.total_transactions,
            avg_transaction_value = EXCLUDED.avg_transaction_value,
            unique_customers = EXCLUDED.unique_customers,
            items_sold = EXCLUDED.items_sold
        `, [
          snapshotDate,
          data.outletId,
          data.outletName,
          data.totalRevenue,
          data.totalTransactions,
          avgValue,
          data.uniqueCustomers.size,
          data.itemsSold
        ]);
        results.outletSnapshots++;
      } catch (err) {
        results.errors.push(`Outlet snapshot error: ${err.message}`);
      }
    }

    const duration = Date.now() - startTime;
    logger.info({
      event: 'snapshot_job_complete',
      snapshotDate,
      duration,
      ...results,
      errorCount: results.errors.length
    });

    return results;

  } catch (error) {
    logger.error({ event: 'snapshot_job_failed', error: error.message });
    results.errors.push(error.message);
    return results;
  }
}

// Vercel serverless handler
module.exports = async (req, res) => {
  // Verify this is a cron request (Vercel sets this header)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    // In production, require CRON_SECRET; in dev, allow all
    if (process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const results = await runSnapshotJob();
    return res.status(200).json({
      success: true,
      message: 'Snapshot job completed',
      ...results
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Export for testing
module.exports.runSnapshotJob = runSnapshotJob;
