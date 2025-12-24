// Chat Tools - Business intelligence query functions for AI assistant
// Each tool is a safe, predefined query that the AI can call

const db = require('./db');
const lightspeed = require('./lightspeedClient');
const logger = require('./logger');

// Tool definitions for Claude API
const toolDefinitions = [
  {
    name: 'getTopSellingProducts',
    description: 'Get the top selling products by quantity or revenue. Use this to answer questions like "What\'s selling best?" or "Top products this week".',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days to look back (default 7)',
          default: 7
        },
        limit: {
          type: 'integer',
          description: 'Number of products to return (default 10)',
          default: 10
        },
        outletId: {
          type: 'string',
          description: 'Filter by specific outlet/location ID (optional)'
        },
        sortBy: {
          type: 'string',
          enum: ['quantity', 'revenue'],
          description: 'Sort by quantity sold or revenue (default revenue)',
          default: 'revenue'
        }
      }
    }
  },
  {
    name: 'getLowStockItems',
    description: 'Get items that are below their reorder point or running low. Use this to answer questions like "What needs reordering?" or "Low stock items".',
    input_schema: {
      type: 'object',
      properties: {
        outletId: {
          type: 'string',
          description: 'Filter by specific outlet/location ID (optional)'
        },
        threshold: {
          type: 'integer',
          description: 'Custom threshold - items with stock at or below this amount (optional, uses reorder_point by default)'
        },
        limit: {
          type: 'integer',
          description: 'Number of items to return (default 20)',
          default: 20
        }
      }
    }
  },
  {
    name: 'getTopCustomers',
    description: 'Get top customers by spending. Use this for questions like "Who are my best customers?" or "Top spenders".',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days to look back (default 30)',
          default: 30
        },
        limit: {
          type: 'integer',
          description: 'Number of customers to return (default 10)',
          default: 10
        },
        outletId: {
          type: 'string',
          description: 'Filter by specific outlet/location ID (optional)'
        }
      }
    }
  },
  {
    name: 'getSalesSummary',
    description: 'Get a summary of sales performance including total revenue, transaction count, and averages. Use this for questions like "How are sales doing?" or "Revenue this week".',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days to look back (default 7)',
          default: 7
        },
        outletId: {
          type: 'string',
          description: 'Filter by specific outlet/location ID (optional)'
        }
      }
    }
  },
  {
    name: 'compareOutlets',
    description: 'Compare performance across different outlet locations. Use this for questions like "Which location is doing better?" or "Compare stores".',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days to look back (default 7)',
          default: 7
        }
      }
    }
  },
  {
    name: 'getInventoryValue',
    description: 'Get the total inventory value by outlet. Use this for questions about stock value or inventory worth.',
    input_schema: {
      type: 'object',
      properties: {
        outletId: {
          type: 'string',
          description: 'Filter by specific outlet/location ID (optional)'
        }
      }
    }
  },
  {
    name: 'getVerificationStats',
    description: 'Get ID verification statistics including approval rates and rejection reasons. Use this for compliance-related questions.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days to look back (default 7)',
          default: 7
        },
        outletId: {
          type: 'string',
          description: 'Filter by specific outlet/location ID (optional)'
        }
      }
    }
  }
];

// Tool implementations
async function getTopSellingProducts({ days = 7, limit = 10, outletId = null, sortBy = 'revenue' } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  if (!db.pool) {
    // Fallback to live Lightspeed data (less accurate but works without snapshots)
    return { error: 'Snapshot data not available. Please run the daily snapshot job first.' };
  }

  try {
    const orderCol = sortBy === 'quantity' ? 'total_quantity' : 'total_revenue';
    const query = `
      SELECT
        product_id,
        product_name,
        sku,
        SUM(quantity_sold) as total_quantity,
        SUM(revenue) as total_revenue,
        SUM(transaction_count) as total_transactions
      FROM daily_sales_snapshots
      WHERE snapshot_date >= $1
        ${outletId ? 'AND outlet_id = $2' : ''}
      GROUP BY product_id, product_name, sku
      ORDER BY ${orderCol} DESC
      LIMIT ${outletId ? '$3' : '$2'}
    `;

    const params = outletId ? [startDateStr, outletId, limit] : [startDateStr, limit];
    const { rows } = await db.pool.query(query, params);

    return {
      period: `Last ${days} days`,
      sortedBy: sortBy,
      products: rows.map(r => ({
        productId: r.product_id,
        name: r.product_name,
        sku: r.sku,
        quantitySold: parseInt(r.total_quantity) || 0,
        revenue: parseFloat(r.total_revenue) || 0,
        transactions: parseInt(r.total_transactions) || 0
      }))
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'getTopSellingProducts', error: error.message });
    return { error: error.message };
  }
}

async function getLowStockItems({ outletId = null, threshold = null, limit = 20 } = {}) {
  if (!db.pool) {
    // Fallback to live Lightspeed inventory
    try {
      const inventory = await lightspeed.listInventory({ outletId, limit: 200 });
      const lowStock = inventory
        .filter(item => {
          if (threshold !== null) {
            return item.currentAmount <= threshold;
          }
          return item.currentAmount <= item.reorderPoint;
        })
        .sort((a, b) => a.currentAmount - b.currentAmount)
        .slice(0, limit);

      return {
        source: 'live',
        items: lowStock.map(item => ({
          productId: item.productId,
          name: item.productName,
          sku: item.sku,
          currentStock: item.currentAmount,
          reorderPoint: item.reorderPoint,
          deficit: item.reorderPoint - item.currentAmount
        }))
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  try {
    // Get most recent inventory snapshot
    const dateQuery = await db.pool.query(`
      SELECT MAX(snapshot_date) as latest_date FROM daily_inventory_snapshots
    `);
    const latestDate = dateQuery.rows[0]?.latest_date;

    if (!latestDate) {
      return { error: 'No inventory snapshots available' };
    }

    const query = `
      SELECT
        product_id,
        product_name,
        sku,
        outlet_id,
        outlet_name,
        current_amount,
        reorder_point,
        (reorder_point - current_amount) as deficit
      FROM daily_inventory_snapshots
      WHERE snapshot_date = $1
        ${outletId ? 'AND outlet_id = $2' : ''}
        AND (
          ${threshold !== null ? `current_amount <= ${threshold}` : 'current_amount <= reorder_point'}
        )
      ORDER BY deficit DESC, current_amount ASC
      LIMIT ${outletId ? '$3' : '$2'}
    `;

    const params = outletId ? [latestDate, outletId, limit] : [latestDate, limit];
    const { rows } = await db.pool.query(query, params);

    return {
      snapshotDate: latestDate,
      items: rows.map(r => ({
        productId: r.product_id,
        name: r.product_name,
        sku: r.sku,
        outlet: r.outlet_name,
        currentStock: parseInt(r.current_amount) || 0,
        reorderPoint: parseInt(r.reorder_point) || 0,
        deficit: parseInt(r.deficit) || 0
      }))
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'getLowStockItems', error: error.message });
    return { error: error.message };
  }
}

async function getTopCustomers({ days = 30, limit = 10, outletId = null } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  if (!db.pool) {
    // Fallback to Lightspeed customer data (year-to-date only)
    try {
      const customers = await lightspeed.listCustomers({ limit: 200 });
      const sorted = customers
        .filter(c => c.yearToDate > 0)
        .sort((a, b) => b.yearToDate - a.yearToDate)
        .slice(0, limit);

      return {
        source: 'year-to-date',
        note: 'Using Lightspeed year-to-date data (daily snapshots not available)',
        customers: sorted.map(c => ({
          customerId: c.customerId,
          name: c.name,
          email: c.email,
          totalSpend: c.yearToDate,
          loyaltyBalance: c.loyaltyBalance
        }))
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  try {
    const query = `
      SELECT
        customer_id,
        customer_name,
        customer_email,
        SUM(transaction_count) as total_transactions,
        SUM(total_spend) as total_spend,
        AVG(avg_transaction_value) as avg_value
      FROM daily_customer_snapshots
      WHERE snapshot_date >= $1
        ${outletId ? 'AND outlet_id = $2' : ''}
      GROUP BY customer_id, customer_name, customer_email
      ORDER BY total_spend DESC
      LIMIT ${outletId ? '$3' : '$2'}
    `;

    const params = outletId ? [startDateStr, outletId, limit] : [startDateStr, limit];
    const { rows } = await db.pool.query(query, params);

    return {
      period: `Last ${days} days`,
      customers: rows.map(r => ({
        customerId: r.customer_id,
        name: r.customer_name,
        email: r.customer_email,
        transactions: parseInt(r.total_transactions) || 0,
        totalSpend: parseFloat(r.total_spend) || 0,
        avgTransactionValue: parseFloat(r.avg_value) || 0
      }))
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'getTopCustomers', error: error.message });
    return { error: error.message };
  }
}

async function getSalesSummary({ days = 7, outletId = null } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  if (!db.pool) {
    return { error: 'Snapshot data not available' };
  }

  try {
    const query = `
      SELECT
        SUM(total_revenue) as total_revenue,
        SUM(total_transactions) as total_transactions,
        AVG(avg_transaction_value) as avg_transaction_value,
        SUM(unique_customers) as unique_customers,
        SUM(items_sold) as items_sold,
        COUNT(DISTINCT snapshot_date) as days_with_data
      FROM daily_outlet_snapshots
      WHERE snapshot_date >= $1
        ${outletId ? 'AND outlet_id = $2' : ''}
    `;

    const params = outletId ? [startDateStr, outletId] : [startDateStr];
    const { rows } = await db.pool.query(query, params);
    const data = rows[0] || {};

    const totalRevenue = parseFloat(data.total_revenue) || 0;
    const totalTransactions = parseInt(data.total_transactions) || 0;
    const daysWithData = parseInt(data.days_with_data) || 1;

    return {
      period: `Last ${days} days`,
      totalRevenue,
      totalTransactions,
      avgTransactionValue: parseFloat(data.avg_transaction_value) || 0,
      uniqueCustomers: parseInt(data.unique_customers) || 0,
      itemsSold: parseInt(data.items_sold) || 0,
      avgDailyRevenue: totalRevenue / daysWithData,
      avgDailyTransactions: totalTransactions / daysWithData
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'getSalesSummary', error: error.message });
    return { error: error.message };
  }
}

async function compareOutlets({ days = 7 } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  if (!db.pool) {
    return { error: 'Snapshot data not available' };
  }

  try {
    const query = `
      SELECT
        outlet_id,
        outlet_name,
        SUM(total_revenue) as total_revenue,
        SUM(total_transactions) as total_transactions,
        AVG(avg_transaction_value) as avg_transaction_value,
        SUM(unique_customers) as unique_customers,
        SUM(items_sold) as items_sold
      FROM daily_outlet_snapshots
      WHERE snapshot_date >= $1
      GROUP BY outlet_id, outlet_name
      ORDER BY total_revenue DESC
    `;

    const { rows } = await db.pool.query(query, [startDateStr]);

    const totalRevenue = rows.reduce((sum, r) => sum + (parseFloat(r.total_revenue) || 0), 0);

    return {
      period: `Last ${days} days`,
      outlets: rows.map(r => ({
        outletId: r.outlet_id,
        name: r.outlet_name,
        revenue: parseFloat(r.total_revenue) || 0,
        revenueShare: totalRevenue > 0 ? ((parseFloat(r.total_revenue) || 0) / totalRevenue * 100).toFixed(1) + '%' : '0%',
        transactions: parseInt(r.total_transactions) || 0,
        avgTransactionValue: parseFloat(r.avg_transaction_value) || 0,
        uniqueCustomers: parseInt(r.unique_customers) || 0,
        itemsSold: parseInt(r.items_sold) || 0
      }))
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'compareOutlets', error: error.message });
    return { error: error.message };
  }
}

async function getInventoryValue({ outletId = null } = {}) {
  if (!db.pool) {
    // Fallback to live calculation
    try {
      const inventory = await lightspeed.listInventory({ outletId, limit: 200 });
      const totalValue = inventory.reduce((sum, item) => {
        return sum + (item.currentAmount || 0) * (item.averageCost || 0);
      }, 0);

      const byOutlet = {};
      for (const item of inventory) {
        const oid = item.outletId || 'UNKNOWN';
        if (!byOutlet[oid]) {
          byOutlet[oid] = { value: 0, itemCount: 0 };
        }
        byOutlet[oid].value += (item.currentAmount || 0) * (item.averageCost || 0);
        byOutlet[oid].itemCount += 1;
      }

      return {
        source: 'live',
        totalValue,
        byOutlet: Object.entries(byOutlet).map(([id, data]) => ({
          outletId: id,
          inventoryValue: data.value,
          uniqueProducts: data.itemCount
        }))
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  try {
    const dateQuery = await db.pool.query(`
      SELECT MAX(snapshot_date) as latest_date FROM daily_inventory_snapshots
    `);
    const latestDate = dateQuery.rows[0]?.latest_date;

    if (!latestDate) {
      return { error: 'No inventory snapshots available' };
    }

    const query = `
      SELECT
        outlet_id,
        outlet_name,
        SUM(inventory_value) as total_value,
        COUNT(DISTINCT product_id) as unique_products,
        SUM(current_amount) as total_units
      FROM daily_inventory_snapshots
      WHERE snapshot_date = $1
        ${outletId ? 'AND outlet_id = $2' : ''}
      GROUP BY outlet_id, outlet_name
      ORDER BY total_value DESC
    `;

    const params = outletId ? [latestDate, outletId] : [latestDate];
    const { rows } = await db.pool.query(query, params);

    const totalValue = rows.reduce((sum, r) => sum + (parseFloat(r.total_value) || 0), 0);

    return {
      snapshotDate: latestDate,
      totalValue,
      byOutlet: rows.map(r => ({
        outletId: r.outlet_id,
        name: r.outlet_name,
        inventoryValue: parseFloat(r.total_value) || 0,
        uniqueProducts: parseInt(r.unique_products) || 0,
        totalUnits: parseInt(r.total_units) || 0
      }))
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'getInventoryValue', error: error.message });
    return { error: error.message };
  }
}

async function getVerificationStats({ days = 7, outletId = null } = {}) {
  if (!db.pool) {
    return { error: 'Database not available' };
  }

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const query = `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status LIKE 'approved%') as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) FILTER (WHERE status = 'approved_override') as overrides
      FROM verifications
      WHERE created_at >= $1
        ${outletId ? 'AND location_id = $2' : ''}
    `;

    const params = outletId ? [startDate, outletId] : [startDate];
    const { rows } = await db.pool.query(query, params);
    const data = rows[0] || {};

    const total = parseInt(data.total) || 0;
    const approved = parseInt(data.approved) || 0;
    const rejected = parseInt(data.rejected) || 0;
    const overrides = parseInt(data.overrides) || 0;

    return {
      period: `Last ${days} days`,
      total,
      approved,
      rejected,
      overrides,
      approvalRate: total > 0 ? ((approved / total) * 100).toFixed(1) + '%' : 'N/A',
      rejectionRate: total > 0 ? ((rejected / total) * 100).toFixed(1) + '%' : 'N/A'
    };
  } catch (error) {
    logger.error({ event: 'tool_error', tool: 'getVerificationStats', error: error.message });
    return { error: error.message };
  }
}

// Execute a tool by name
async function executeTool(toolName, args = {}) {
  const tools = {
    getTopSellingProducts,
    getLowStockItems,
    getTopCustomers,
    getSalesSummary,
    compareOutlets,
    getInventoryValue,
    getVerificationStats
  };

  const fn = tools[toolName];
  if (!fn) {
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    return await fn(args);
  } catch (error) {
    logger.error({ event: 'tool_execution_error', tool: toolName, error: error.message });
    return { error: error.message };
  }
}

module.exports = {
  toolDefinitions,
  executeTool,
  // Export individual tools for testing
  getTopSellingProducts,
  getLowStockItems,
  getTopCustomers,
  getSalesSummary,
  compareOutlets,
  getInventoryValue,
  getVerificationStats
};
