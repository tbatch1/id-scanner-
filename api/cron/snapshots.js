// Daily snapshot job - aggregates Lightspeed data into local DB for fast BI queries
// Schedule: configured in `vercel.json` (UTC).

const lightspeed = require('../../backend/src/lightspeedClient');
const db = require('../../backend/src/db');
const logger = require('../../backend/src/logger');

async function ensureSnapshotTables(pool) {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_sales_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_date DATE NOT NULL,
      outlet_id VARCHAR(64),
      outlet_name VARCHAR(255),
      product_id VARCHAR(64),
      product_name VARCHAR(255),
      sku VARCHAR(100),
      category_name VARCHAR(255),
      quantity_sold INTEGER DEFAULT 0,
      revenue DECIMAL(12,2) DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, outlet_id, product_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_snapshots_date ON daily_sales_snapshots(snapshot_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_snapshots_outlet ON daily_sales_snapshots(outlet_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_snapshots_product ON daily_sales_snapshots(product_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_inventory_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_date DATE NOT NULL,
      outlet_id VARCHAR(64),
      outlet_name VARCHAR(255),
      product_id VARCHAR(64),
      product_name VARCHAR(255),
      sku VARCHAR(100),
      category_name VARCHAR(255),
      current_amount INTEGER,
      reorder_point INTEGER,
      average_cost DECIMAL(10,2),
      retail_price DECIMAL(10,2),
      inventory_value DECIMAL(12,2),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, outlet_id, product_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_date ON daily_inventory_snapshots(snapshot_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_outlet ON daily_inventory_snapshots(outlet_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_low_stock ON daily_inventory_snapshots(current_amount, reorder_point);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_customer_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_date DATE NOT NULL,
      customer_id VARCHAR(64),
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      outlet_id VARCHAR(64),
      outlet_name VARCHAR(255),
      transaction_count INTEGER DEFAULT 0,
      total_spend DECIMAL(12,2) DEFAULT 0,
      avg_transaction_value DECIMAL(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, customer_id, outlet_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_snapshots_date ON daily_customer_snapshots(snapshot_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_snapshots_customer ON daily_customer_snapshots(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_snapshots_spend ON daily_customer_snapshots(total_spend DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_outlet_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_date DATE NOT NULL,
      outlet_id VARCHAR(64),
      outlet_name VARCHAR(255),
      total_revenue DECIMAL(12,2) DEFAULT 0,
      total_transactions INTEGER DEFAULT 0,
      avg_transaction_value DECIMAL(10,2) DEFAULT 0,
      unique_customers INTEGER DEFAULT 0,
      items_sold INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, outlet_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outlet_snapshots_date ON daily_outlet_snapshots(snapshot_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outlet_snapshots_outlet ON daily_outlet_snapshots(outlet_id);`);
}

function formatYmdInTimeZone(date, timeZone) {
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

function zonedDateTimeToUtcIso({ ymd, timeZone, hour, minute, second }) {
  const [year, month, day] = String(ymd).split('-').map((v) => Number.parseInt(v, 10));
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(utcGuess);

  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  const asUtc = new Date(`${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`);
  const offsetMs = asUtc.getTime() - utcGuess.getTime();
  const actualUtc = new Date(utcGuess.getTime() - offsetMs);
  return actualUtc.toISOString().replace('.000Z', 'Z');
}

function hourInTimeZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false
    }).formatToParts(date);

    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = Number.parseInt(hourPart?.value, 10);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    return null;
  }
}

function pickDefaultSnapshotDate({ now, timeZone }) {
  const cutoffHour = Math.max(0, Math.min(23, Number.parseInt(process.env.SNAPSHOT_DAY_CUTOFF_HOUR || '6', 10) || 6));
  const localHour = hourInTimeZone(now, timeZone) ?? cutoffHour;
  const baseDate = localHour < cutoffHour ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : now;
  return formatYmdInTimeZone(baseDate, timeZone);
}

async function runSnapshotJob({ mode = 'all', date = null } = {}) {
  const startTime = Date.now();
  const now = new Date();
  const defaultSnapshotDate = pickDefaultSnapshotDate({ now, timeZone: 'UTC' });

  const requestedDate = date ? String(date).trim() : null;
  const isIsoDate = requestedDate ? /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) : false;

  const normalizedMode = String(mode || 'all').toLowerCase();
  const allowedModes = new Set(['all', 'sales', 'inventory', 'customers', 'outlets', 'setup', 'probe']);
  const effectiveMode = allowedModes.has(normalizedMode) ? normalizedMode : 'all';

   logger.info({ event: 'snapshot_job_start', snapshotDate: defaultSnapshotDate, mode: effectiveMode, requestedDate: isIsoDate ? requestedDate : null });

  const results = {
    salesSnapshots: 0,
    inventorySnapshots: 0,
    customerSnapshots: 0,
    outletSnapshots: 0,
    salesFetched: 0,
    outletsProcessed: 0,
    customerLookupsAttempted: 0,
    customerLookupsSucceeded: 0,
    errors: []
  };

  try {
    if (!db.pool) {
      throw new Error('Database not available');
    }

    await ensureSnapshotTables(db.pool);

    if (effectiveMode === 'setup') {
      const duration = Date.now() - startTime;
      logger.info({ event: 'snapshot_job_setup_complete', snapshotDate: defaultSnapshotDate, duration });
      return results;
    }

    if (effectiveMode === 'probe') {
      try {
        if (typeof lightspeed.searchSalesRaw !== 'function') {
          results.errors.push('searchSalesRaw not supported by Lightspeed client');
        } else {
          const sample = await lightspeed.searchSalesRaw({ limit: 1 });
          results.sampleSaleId = sample?.[0]?.id || null;

          const probeFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z');
          const probeTo = now.toISOString().replace('.000Z', 'Z');
          const recent = await lightspeed.searchSalesRaw({
            limit: 5,
            state: 'CLOSED',
            dateFrom: probeFrom,
            dateTo: probeTo
          });
          results.probeRecentCount = Array.isArray(recent) ? recent.length : 0;

          const allTime = await lightspeed.searchSalesRaw({
            limit: 1,
            dateFrom: '2000-01-01T00:00:00Z',
            dateTo: '2100-01-01T00:00:00Z'
          });
          results.probeAllTimeCount = Array.isArray(allTime) ? allTime.length : 0;
        }
      } catch (probeError) {
        results.errors.push(`Probe failed: ${probeError.message}`);
      }

      const duration = Date.now() - startTime;
      logger.info({ event: 'snapshot_job_probe_complete', duration, errorCount: results.errors.length });
      return results;
    }

    // 1. Fetch outlets for reference
    const outlets = await lightspeed.listOutlets();
    const outletMap = {};
    for (const outlet of outlets) {
      outletMap[outlet.outletId] = outlet;
    }

    const includeSalesDerived = effectiveMode === 'all' || effectiveMode === 'sales' || effectiveMode === 'customers' || effectiveMode === 'outlets';
    const includeInventory = effectiveMode === 'all' || effectiveMode === 'inventory';
    const writeSales = effectiveMode === 'all' || effectiveMode === 'sales';
    const writeCustomers = effectiveMode === 'all' || effectiveMode === 'sales' || effectiveMode === 'customers';
    const writeOutlets = effectiveMode === 'all' || effectiveMode === 'sales' || effectiveMode === 'outlets';

    if (includeSalesDerived) {
      // 2. Fetch yesterday's closed sales with line items (per outlet to reduce payload size)
      const salesAgg = {};
      const customerAgg = {};
      const outletAgg = {};

      for (const outlet of outlets) {
        try {
          const timeZone = outlet.timezone || outlet.timeZone || 'UTC';
          const snapshotDate = isIsoDate ? requestedDate : pickDefaultSnapshotDate({ now, timeZone });
          const dateFrom = zonedDateTimeToUtcIso({ ymd: snapshotDate, timeZone, hour: 0, minute: 0, second: 0 });
          const dateTo = zonedDateTimeToUtcIso({ ymd: snapshotDate, timeZone, hour: 23, minute: 59, second: 59 });
          const sales = typeof lightspeed.searchSalesWithLineItems === 'function'
            ? await lightspeed.searchSalesWithLineItems({
              outletId: outlet.outletId,
              state: 'CLOSED',
              dateFrom,
              dateTo,
              limit: 1000
            })
            : await lightspeed.listSalesWithLineItems({
              status: 'CLOSED',
              limit: 200,
              outletId: outlet.outletId
            });

          results.outletsProcessed += 1;
          results.salesFetched += Array.isArray(sales) ? sales.length : 0;

          for (const sale of sales) {
            const outletId = sale.outletId || outlet.outletId || 'UNKNOWN';
            const outletName = outletMap[outletId]?.name || outlet.name || outletId;
            const customerId = sale.customerId;

            // Initialize outlet aggregate
            const outletAggKey = `${snapshotDate}|${outletId}`;
            if (!outletAgg[outletAggKey]) {
              outletAgg[outletAggKey] = {
                snapshotDate,
                outletId,
                outletName,
                totalRevenue: 0,
                totalTransactions: 0,
                uniqueCustomers: new Set(),
                itemsSold: 0
              };
            }
            outletAgg[outletAggKey].totalRevenue += sale.total || 0;
            outletAgg[outletAggKey].totalTransactions += 1;
            if (customerId) {
              outletAgg[outletAggKey].uniqueCustomers.add(customerId);
            }

            // Aggregate by customer (if known)
            if (customerId) {
              const custKey = `${snapshotDate}|${customerId}|${outletId}`;
              if (!customerAgg[custKey]) {
                customerAgg[custKey] = {
                  snapshotDate,
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
              const key = `${snapshotDate}|${outletId}|${productId}`;

              if (!salesAgg[key]) {
                salesAgg[key] = {
                  snapshotDate,
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
              outletAgg[outletAggKey].itemsSold += qty;
            }
          }
        } catch (err) {
          results.errors.push(`Sales fetch error for ${outlet.outletId}: ${err.message}`);
        }
      }

      if (writeSales) {
        // 3. Insert sales snapshots
        for (const data of Object.values(salesAgg)) {
          try {
            await db.pool.query(
              `
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
              `,
              [
                data.snapshotDate,
                data.outletId,
                data.outletName,
                data.productId,
                data.productName,
                data.sku,
                data.categoryName,
                data.quantitySold,
                data.revenue,
                data.transactionCount
              ]
            );
            results.salesSnapshots++;
          } catch (err) {
            results.errors.push(`Sales snapshot error: ${err.message}`);
          }
        }
      }
 
      // 6. Insert customer snapshots (aggregated)
      if (writeCustomers) {
        const customerDetailsById = new Map();
        if (typeof lightspeed.getCustomerById === 'function') {
          const maxLookups = Math.max(
            0,
            Number.parseInt(process.env.SNAPSHOT_CUSTOMER_LOOKUP_LIMIT || '2000', 10) || 2000
          );
          const concurrency = Math.max(
            1,
            Math.min(10, Number.parseInt(process.env.SNAPSHOT_CUSTOMER_LOOKUP_CONCURRENCY || '6', 10) || 6)
          );

          const uniqueCustomerIds = Array.from(
            new Set(Object.values(customerAgg).map((row) => row.customerId).filter(Boolean))
          );

          const lookupIds = maxLookups > 0 ? uniqueCustomerIds.slice(0, maxLookups) : [];
          if (uniqueCustomerIds.length > lookupIds.length) {
            results.errors.push(
              `Customer lookup capped at ${lookupIds.length}/${uniqueCustomerIds.length}; increase SNAPSHOT_CUSTOMER_LOOKUP_LIMIT if needed`
            );
          }

          for (let i = 0; i < lookupIds.length; i += concurrency) {
            const batch = lookupIds.slice(i, i + concurrency);
            const batchResults = await Promise.all(
              batch.map(async (customerId) => {
                results.customerLookupsAttempted += 1;
                try {
                  const customer = await lightspeed.getCustomerById(customerId);
                  if (customer && (customer.name || customer.email)) {
                    customerDetailsById.set(customerId, customer);
                    results.customerLookupsSucceeded += 1;
                  }
                } catch (err) {
                  results.errors.push(`Customer lookup error (${customerId}): ${err.message}`);
                }
              })
            );
            void batchResults;
          }
        }

        for (const data of Object.values(customerAgg)) {
          try {
            const avgValue = data.transactionCount > 0 ? data.totalSpend / data.transactionCount : 0;
            const customerDetails = data.customerId ? (customerDetailsById.get(data.customerId) || null) : null;

            await db.pool.query(
              `
                INSERT INTO daily_customer_snapshots
                  (snapshot_date, customer_id, customer_name, customer_email, outlet_id, outlet_name, transaction_count, total_spend, avg_transaction_value)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (snapshot_date, customer_id, outlet_id)
                DO UPDATE SET
                  transaction_count = EXCLUDED.transaction_count,
                  total_spend = EXCLUDED.total_spend,
                  avg_transaction_value = EXCLUDED.avg_transaction_value,
                  customer_name = COALESCE(daily_customer_snapshots.customer_name, EXCLUDED.customer_name),
                  customer_email = COALESCE(daily_customer_snapshots.customer_email, EXCLUDED.customer_email),
                  outlet_name = EXCLUDED.outlet_name
              `,
              [
                data.snapshotDate,
                data.customerId,
                customerDetails?.name || null,
                customerDetails?.email || null,
                data.outletId,
                data.outletName,
                data.transactionCount,
                data.totalSpend,
                avgValue
              ]
            );
            results.customerSnapshots++;
          } catch (err) {
            results.errors.push(`Customer snapshot error: ${err.message}`);
          }
        }
      }

      // 7. Insert outlet summary snapshots
      if (writeOutlets) {
        for (const data of Object.values(outletAgg)) {
          try {
            const avgValue = data.totalTransactions > 0 ? data.totalRevenue / data.totalTransactions : 0;

            await db.pool.query(
              `
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
              `,
              [
                data.snapshotDate,
                data.outletId,
                data.outletName,
                data.totalRevenue,
                data.totalTransactions,
                avgValue,
                data.uniqueCustomers.size,
                data.itemsSold
              ]
            );
            results.outletSnapshots++;
          } catch (err) {
            results.errors.push(`Outlet snapshot error: ${err.message}`);
          }
        }
      }
    }

    // 5. Fetch and insert inventory snapshots
    if (includeInventory) {
      for (const outlet of outlets) {
        try {
          const timeZone = outlet.timezone || outlet.timeZone || 'UTC';
          const snapshotDate = isIsoDate ? requestedDate : pickDefaultSnapshotDate({ now, timeZone });
          const inventory = await lightspeed.listInventory({ outletId: outlet.outletId, limit: 200, allPages: true });

          for (const item of inventory) {
            try {
              const inventoryValue = (item.currentAmount || 0) * (item.averageCost || 0);
              await db.pool.query(
                `
                INSERT INTO daily_inventory_snapshots
                  (snapshot_date, outlet_id, outlet_name, product_id, product_name, sku, current_amount, reorder_point, average_cost, retail_price, inventory_value)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (snapshot_date, outlet_id, product_id)
                DO UPDATE SET
                  current_amount = EXCLUDED.current_amount,
                  reorder_point = EXCLUDED.reorder_point,
                  average_cost = EXCLUDED.average_cost,
                  inventory_value = EXCLUDED.inventory_value
                `,
                [
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
                ]
              );
              results.inventorySnapshots++;
            } catch (err) {
              results.errors.push(`Inventory item error: ${err.message}`);
            }
          }
        } catch (err) {
          results.errors.push(`Inventory fetch error for ${outlet.outletId}: ${err.message}`);
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info({
      event: 'snapshot_job_complete',
      snapshotDate: defaultSnapshotDate,
      duration,
      mode: effectiveMode,
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
    const mode = (req.query?.mode || req.body?.mode || 'all');
    const date = (req.query?.date || req.body?.date || null);
    const results = await runSnapshotJob({ mode, date });
    return res.status(200).json({
      success: true,
      message: 'Snapshot job completed',
      mode,
      date: date || null,
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
