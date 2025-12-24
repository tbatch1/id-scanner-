-- Daily snapshot tables for AI assistant business intelligence queries
-- These tables store aggregated data from Lightspeed for fast historical analysis

-- Daily sales summary by outlet/product
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
);

CREATE INDEX IF NOT EXISTS idx_sales_snapshots_date ON daily_sales_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_sales_snapshots_outlet ON daily_sales_snapshots(outlet_id);
CREATE INDEX IF NOT EXISTS idx_sales_snapshots_product ON daily_sales_snapshots(product_id);

COMMENT ON TABLE daily_sales_snapshots IS 'Daily aggregated sales data by outlet and product for BI queries';

-- Daily inventory snapshot
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
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_date ON daily_inventory_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_outlet ON daily_inventory_snapshots(outlet_id);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_low_stock ON daily_inventory_snapshots(current_amount, reorder_point);

COMMENT ON TABLE daily_inventory_snapshots IS 'Daily inventory levels by outlet and product for stock tracking';

-- Daily customer activity
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
);

CREATE INDEX IF NOT EXISTS idx_customer_snapshots_date ON daily_customer_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_customer_snapshots_customer ON daily_customer_snapshots(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_snapshots_spend ON daily_customer_snapshots(total_spend DESC);

COMMENT ON TABLE daily_customer_snapshots IS 'Daily customer purchase activity for top customer analysis';

-- Daily outlet summary (aggregate totals per location)
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
);

CREATE INDEX IF NOT EXISTS idx_outlet_snapshots_date ON daily_outlet_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_outlet_snapshots_outlet ON daily_outlet_snapshots(outlet_id);

COMMENT ON TABLE daily_outlet_snapshots IS 'Daily outlet-level summary for location comparison';
