const lightspeed = require('./lightspeedClient');
const logger = require('./logger');

const CURSOR_KEY_CUSTOMERS = 'lightspeed.customers.version';

function toTrimmedString(value, maxLen = 255) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function toNullableText(value, maxLen = 4000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function toNullableNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toNullableBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return null;
}

function toNullableDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function toNullableTimestamp(value) {
  if (!value) return null;
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

async function ensureMarketingTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_cursors (
      key TEXT PRIMARY KEY,
      cursor BIGINT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_profiles (
      customer_id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255),
      first_name VARCHAR(120),
      last_name VARCHAR(120),
      email VARCHAR(255),
      phone VARCHAR(80),
      mobile VARCHAR(80),
      customer_code VARCHAR(120),
      company_name VARCHAR(255),
      note TEXT,
      date_of_birth DATE,
      sex VARCHAR(20),
      website VARCHAR(255),
      twitter VARCHAR(255),
      enable_loyalty BOOLEAN,
      loyalty_balance DECIMAL(12,2),
      year_to_date DECIMAL(12,2),
      balance DECIMAL(12,2),
      customer_group_id VARCHAR(64),
      physical_address1 VARCHAR(255),
      physical_address2 VARCHAR(255),
      physical_suburb VARCHAR(255),
      physical_city VARCHAR(255),
      physical_state VARCHAR(255),
      physical_postcode VARCHAR(40),
      physical_country VARCHAR(80),
      postal_address1 VARCHAR(255),
      postal_address2 VARCHAR(255),
      postal_suburb VARCHAR(255),
      postal_city VARCHAR(255),
      postal_state VARCHAR(255),
      postal_postcode VARCHAR(40),
      postal_country VARCHAR(80),
      custom_field_1 TEXT,
      custom_field_2 TEXT,
      custom_field_3 TEXT,
      custom_field_4 TEXT,
      version BIGINT,
      lightspeed_created_at TIMESTAMP,
      lightspeed_updated_at TIMESTAMP,
      synced_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Schema drift guard: older deployments may have created a subset of columns.
  await pool.query(`
    ALTER TABLE customer_profiles
      ADD COLUMN IF NOT EXISTS name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS first_name VARCHAR(120),
      ADD COLUMN IF NOT EXISTS last_name VARCHAR(120),
      ADD COLUMN IF NOT EXISTS email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS phone VARCHAR(80),
      ADD COLUMN IF NOT EXISTS mobile VARCHAR(80),
      ADD COLUMN IF NOT EXISTS customer_code VARCHAR(120),
      ADD COLUMN IF NOT EXISTS company_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS note TEXT,
      ADD COLUMN IF NOT EXISTS date_of_birth DATE,
      ADD COLUMN IF NOT EXISTS sex VARCHAR(20),
      ADD COLUMN IF NOT EXISTS website VARCHAR(255),
      ADD COLUMN IF NOT EXISTS twitter VARCHAR(255),
      ADD COLUMN IF NOT EXISTS enable_loyalty BOOLEAN,
      ADD COLUMN IF NOT EXISTS loyalty_balance DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS year_to_date DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS balance DECIMAL(12,2),
      ADD COLUMN IF NOT EXISTS customer_group_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS physical_address1 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS physical_address2 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS physical_suburb VARCHAR(255),
      ADD COLUMN IF NOT EXISTS physical_city VARCHAR(255),
      ADD COLUMN IF NOT EXISTS physical_state VARCHAR(255),
      ADD COLUMN IF NOT EXISTS physical_postcode VARCHAR(40),
      ADD COLUMN IF NOT EXISTS physical_country VARCHAR(80),
      ADD COLUMN IF NOT EXISTS postal_address1 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS postal_address2 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS postal_suburb VARCHAR(255),
      ADD COLUMN IF NOT EXISTS postal_city VARCHAR(255),
      ADD COLUMN IF NOT EXISTS postal_state VARCHAR(255),
      ADD COLUMN IF NOT EXISTS postal_postcode VARCHAR(40),
      ADD COLUMN IF NOT EXISTS postal_country VARCHAR(80),
      ADD COLUMN IF NOT EXISTS custom_field_1 TEXT,
      ADD COLUMN IF NOT EXISTS custom_field_2 TEXT,
      ADD COLUMN IF NOT EXISTS custom_field_3 TEXT,
      ADD COLUMN IF NOT EXISTS custom_field_4 TEXT,
      ADD COLUMN IF NOT EXISTS version BIGINT,
      ADD COLUMN IF NOT EXISTS lightspeed_created_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS lightspeed_updated_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP NOT NULL DEFAULT NOW()
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_synced_at ON customer_profiles(synced_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_dob ON customer_profiles(date_of_birth);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_sex ON customer_profiles(sex);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_zip ON customer_profiles(physical_postcode);`);
}

async function getCursor(pool, key) {
  const { rows } = await pool.query('SELECT cursor FROM sync_cursors WHERE key = $1', [key]);
  const cursor = rows[0]?.cursor ?? null;
  return cursor === null ? null : Number(cursor);
}

async function setCursor(pool, key, cursor) {
  const normalized = cursor === null || cursor === undefined ? null : Number(cursor);
  await pool.query(
    `
      INSERT INTO sync_cursors (key, cursor, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()
    `,
    [key, normalized]
  );
}

function mapCustomerProfile(customer) {
  if (!customer) return null;

  const id = toTrimmedString(customer.id || customer.customer_id || customer.customerId, 64);
  if (!id) return null;

  const physicalAddress1 = customer.physical_address_1 ?? customer.physical_address1 ?? null;
  const physicalAddress2 = customer.physical_address_2 ?? customer.physical_address2 ?? null;
  const postalAddress1 = customer.postal_address_1 ?? customer.postal_address1 ?? null;
  const postalAddress2 = customer.postal_address_2 ?? customer.postal_address2 ?? null;

  return {
    customer_id: id,
    name:
      toTrimmedString(customer.name, 255) ||
      toTrimmedString([customer.first_name, customer.last_name].filter(Boolean).join(' '), 255),
    first_name: toTrimmedString(customer.first_name, 120),
    last_name: toTrimmedString(customer.last_name, 120),
    email: toTrimmedString(customer.email, 255),
    phone: toTrimmedString(customer.phone, 80),
    mobile: toTrimmedString(customer.mobile, 80),
    customer_code: toTrimmedString(customer.customer_code || customer.code, 120),
    company_name: toTrimmedString(customer.company_name, 255),
    note: toNullableText(customer.note, 6000),
    date_of_birth: toNullableDate(customer.date_of_birth || customer.dateOfBirth),
    sex: toTrimmedString(customer.gender || customer.sex, 20),
    website: toTrimmedString(customer.website, 255),
    twitter: toTrimmedString(customer.twitter, 255),
    enable_loyalty: toNullableBoolean(customer.enable_loyalty),
    loyalty_balance: toNullableNumber(customer.loyalty_balance),
    year_to_date: toNullableNumber(customer.year_to_date),
    balance: toNullableNumber(customer.balance),
    customer_group_id: toTrimmedString(customer.customer_group_id, 64),
    physical_address1: toTrimmedString(physicalAddress1, 255),
    physical_address2: toTrimmedString(physicalAddress2, 255),
    physical_suburb: toTrimmedString(customer.physical_suburb, 255),
    physical_city: toTrimmedString(customer.physical_city, 255),
    physical_state: toTrimmedString(customer.physical_state, 255),
    physical_postcode: toTrimmedString(customer.physical_postcode, 40),
    physical_country: toTrimmedString(customer.physical_country, 80),
    postal_address1: toTrimmedString(postalAddress1, 255),
    postal_address2: toTrimmedString(postalAddress2, 255),
    postal_suburb: toTrimmedString(customer.postal_suburb, 255),
    postal_city: toTrimmedString(customer.postal_city, 255),
    postal_state: toTrimmedString(customer.postal_state, 255),
    postal_postcode: toTrimmedString(customer.postal_postcode, 40),
    postal_country: toTrimmedString(customer.postal_country, 80),
    custom_field_1: toNullableText(customer.custom_field_1, 2000),
    custom_field_2: toNullableText(customer.custom_field_2, 2000),
    custom_field_3: toNullableText(customer.custom_field_3, 2000),
    custom_field_4: toNullableText(customer.custom_field_4, 2000),
    version: Number.isFinite(Number(customer.version)) ? Number(customer.version) : null,
    lightspeed_created_at: toNullableTimestamp(customer.created_at),
    lightspeed_updated_at: toNullableTimestamp(customer.updated_at)
  };
}

async function upsertCustomerProfiles(pool, profiles) {
  if (!profiles.length) return 0;

  const columns = [
    'customer_id',
    'name',
    'first_name',
    'last_name',
    'email',
    'phone',
    'mobile',
    'customer_code',
    'company_name',
    'note',
    'date_of_birth',
    'sex',
    'website',
    'twitter',
    'enable_loyalty',
    'loyalty_balance',
    'year_to_date',
    'balance',
    'customer_group_id',
    'physical_address1',
    'physical_address2',
    'physical_suburb',
    'physical_city',
    'physical_state',
    'physical_postcode',
    'physical_country',
    'postal_address1',
    'postal_address2',
    'postal_suburb',
    'postal_city',
    'postal_state',
    'postal_postcode',
    'postal_country',
    'custom_field_1',
    'custom_field_2',
    'custom_field_3',
    'custom_field_4',
    'version',
    'lightspeed_created_at',
    'lightspeed_updated_at'
  ];

  const values = [];
  const placeholders = [];
  let paramIndex = 1;

  for (const profile of profiles) {
    const row = columns.map((col) => profile[col] ?? null);
    values.push(...row);
    const rowPlaceholders = row.map(() => `$${paramIndex++}`);
    placeholders.push(`(${rowPlaceholders.join(', ')}, NOW())`);
  }

  const query = `
    INSERT INTO customer_profiles (
      ${columns.join(', ')},
      synced_at
    )
    VALUES
      ${placeholders.join(',\n')}
    ON CONFLICT (customer_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      mobile = EXCLUDED.mobile,
      customer_code = EXCLUDED.customer_code,
      company_name = EXCLUDED.company_name,
      note = EXCLUDED.note,
      date_of_birth = EXCLUDED.date_of_birth,
      sex = EXCLUDED.sex,
      website = EXCLUDED.website,
      twitter = EXCLUDED.twitter,
      enable_loyalty = EXCLUDED.enable_loyalty,
      loyalty_balance = EXCLUDED.loyalty_balance,
      year_to_date = EXCLUDED.year_to_date,
      balance = EXCLUDED.balance,
      customer_group_id = EXCLUDED.customer_group_id,
      physical_address1 = EXCLUDED.physical_address1,
      physical_address2 = EXCLUDED.physical_address2,
      physical_suburb = EXCLUDED.physical_suburb,
      physical_city = EXCLUDED.physical_city,
      physical_state = EXCLUDED.physical_state,
      physical_postcode = EXCLUDED.physical_postcode,
      physical_country = EXCLUDED.physical_country,
      postal_address1 = EXCLUDED.postal_address1,
      postal_address2 = EXCLUDED.postal_address2,
      postal_suburb = EXCLUDED.postal_suburb,
      postal_city = EXCLUDED.postal_city,
      postal_state = EXCLUDED.postal_state,
      postal_postcode = EXCLUDED.postal_postcode,
      postal_country = EXCLUDED.postal_country,
      custom_field_1 = EXCLUDED.custom_field_1,
      custom_field_2 = EXCLUDED.custom_field_2,
      custom_field_3 = EXCLUDED.custom_field_3,
      custom_field_4 = EXCLUDED.custom_field_4,
      version = EXCLUDED.version,
      lightspeed_created_at = EXCLUDED.lightspeed_created_at,
      lightspeed_updated_at = EXCLUDED.lightspeed_updated_at,
      synced_at = NOW()
  `;

  await pool.query(query, values);
  return profiles.length;
}

async function syncCustomerProfiles(pool, { maxDurationMs = 8000, pageSize = 200, maxPages = 50, resetCursor = false } = {}) {
  const start = Date.now();
  await ensureMarketingTables(pool);

  if (resetCursor) {
    await setCursor(pool, CURSOR_KEY_CUSTOMERS, null);
  }

  let after = await getCursor(pool, CURSOR_KEY_CUSTOMERS);
  if (!Number.isFinite(after)) after = null;

  const normalizedPageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 200, 200));
  const normalizedMaxPages = Math.max(1, Math.min(Number.parseInt(maxPages, 10) || 50, 500));

  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  let cursor = after;
  let done = false;

  while (pages < normalizedMaxPages) {
    const remaining = maxDurationMs - (Date.now() - start);
    if (remaining < 1200) break;

    if (typeof lightspeed.listCustomersRaw !== 'function') {
      throw new Error('Lightspeed client does not support listCustomersRaw');
    }

    const customers = await lightspeed.listCustomersRaw({ after: cursor, pageSize: normalizedPageSize });
    pages += 1;

    if (!Array.isArray(customers) || customers.length === 0) {
      done = true;
      break;
    }

    fetched += customers.length;
    const mapped = customers.map(mapCustomerProfile).filter(Boolean);
    upserted += await upsertCustomerProfiles(pool, mapped);

    const versions = customers
      .map((item) => (item && item.version !== undefined ? Number(item.version) : NaN))
      .filter((v) => Number.isFinite(v));
    const nextCursor = versions.length ? Math.max(...versions) : null;

    if (!Number.isFinite(nextCursor) || nextCursor === cursor) {
      done = true;
      break;
    }

    cursor = nextCursor;
    await setCursor(pool, CURSOR_KEY_CUSTOMERS, cursor);
  }

  const durationMs = Date.now() - start;
  logger.info(
    { event: 'marketing_customer_sync', fetched, upserted, pages, cursor, done, durationMs },
    'Marketing customer profile sync completed'
  );

  return { fetched, upserted, pages, cursor, done, durationMs };
}

async function getMarketingHealth(pool) {
  await ensureMarketingTables(pool);
  const [{ rows: presentRows }, { rows: countRows }, cursor] = await Promise.all([
    pool.query(
      `
        SELECT
          to_regclass('public.customer_profiles') as customer_profiles,
          to_regclass('public.sync_cursors') as sync_cursors
      `
    ),
    pool.query('SELECT COUNT(*)::int as count, MAX(synced_at) as last_synced_at FROM customer_profiles'),
    getCursor(pool, CURSOR_KEY_CUSTOMERS)
  ]);

  const present = presentRows[0] || {};
  return {
    tablesPresent: {
      customerProfiles: Boolean(present.customer_profiles),
      syncCursors: Boolean(present.sync_cursors)
    },
    profilesCount: countRows[0]?.count ?? 0,
    lastSyncedAt: countRows[0]?.last_synced_at ?? null,
    cursor: cursor ?? null
  };
}

async function getMarketingSummary(pool, { days = 90 } = {}) {
  await ensureMarketingTables(pool);
  const normalizedDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 90, 3650));

  const [{ rows: snapshotRows }] = await Promise.all([
    pool.query(`SELECT to_regclass('public.daily_customer_snapshots') as daily_customer_snapshots`)
  ]);
  const hasDailySnapshots = Boolean(snapshotRows?.[0]?.daily_customer_snapshots);

  const summaryQuery = `
    SELECT
      COUNT(*)::int as total_customers,
      COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int as with_email,
      COUNT(*) FILTER (WHERE (mobile IS NOT NULL AND mobile <> '') OR (phone IS NOT NULL AND phone <> ''))::int as with_phone,
      COUNT(*) FILTER (WHERE date_of_birth IS NOT NULL)::int as with_dob,
      COUNT(*) FILTER (WHERE sex IS NOT NULL AND sex <> '')::int as with_sex,
      COUNT(*) FILTER (WHERE physical_postcode IS NOT NULL AND physical_postcode <> '')::int as with_postcode,
      COUNT(*) FILTER (WHERE enable_loyalty IS TRUE)::int as loyalty_enabled,
      COUNT(*) FILTER (WHERE loyalty_balance IS NOT NULL AND loyalty_balance > 0)::int as loyalty_positive
    FROM customer_profiles
  `;

  const activityQuery = `
    SELECT COUNT(DISTINCT customer_id)::int as active_customers
    FROM daily_customer_snapshots
    WHERE snapshot_date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
      AND customer_id IS NOT NULL
      AND transaction_count > 0
  `;

  const topZipQuery = `
    SELECT physical_postcode as zip, COUNT(*)::int as count
    FROM customer_profiles
    WHERE physical_postcode IS NOT NULL AND physical_postcode <> ''
    GROUP BY physical_postcode
    ORDER BY count DESC
    LIMIT 10
  `;

  const topCityQuery = `
    SELECT physical_city as city, COUNT(*)::int as count
    FROM customer_profiles
    WHERE physical_city IS NOT NULL AND physical_city <> ''
    GROUP BY physical_city
    ORDER BY count DESC
    LIMIT 10
  `;

  const ageBucketsQuery = `
    WITH buckets AS (
      SELECT
        CASE
          WHEN date_of_birth IS NULL THEN 'Unknown'
          ELSE
            CASE
              WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) < 21 THEN '<21'
              WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 21 AND 24 THEN '21-24'
              WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 25 AND 34 THEN '25-34'
              WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 35 AND 44 THEN '35-44'
              WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 45 AND 54 THEN '45-54'
              ELSE '55+'
            END
        END as bucket,
        COUNT(*)::int as count
      FROM customer_profiles
      GROUP BY 1
    )
    SELECT bucket, count
    FROM buckets
    ORDER BY
      CASE bucket
        WHEN '21-24' THEN 1
        WHEN '25-34' THEN 2
        WHEN '35-44' THEN 3
        WHEN '45-54' THEN 4
        WHEN '55+' THEN 5
        WHEN '<21' THEN 6
        ELSE 7
      END ASC
  `;

  const [summaryRes, zipRes, cityRes, ageRes] = await Promise.all([
    pool.query(summaryQuery),
    pool.query(topZipQuery),
    pool.query(topCityQuery),
    pool.query(ageBucketsQuery)
  ]);

  let activityRow = { active_customers: 0 };
  const warnings = [];
  if (hasDailySnapshots) {
    try {
      const activityRes = await pool.query(activityQuery, [normalizedDays]);
      activityRow = activityRes.rows[0] || activityRow;
    } catch (error) {
      warnings.push('Daily customer snapshots query failed; active customer counts unavailable.');
      logger.logAPIError('marketing_activity_query_failed', error);
    }
  } else {
    warnings.push('Daily customer snapshots not available yet; run the nightly snapshots job to unlock activity + VIP segments.');
  }

  return {
    days: normalizedDays,
    customers: summaryRes.rows[0],
    activity: activityRow,
    topZips: zipRes.rows,
    topCities: cityRes.rows,
    ageBuckets: ageRes.rows,
    warnings
  };
}

function segmentDefinitions() {
  return [
    {
      id: 'age_21_24',
      name: 'Age 21–24',
      description: 'Customers with DOB indicating age 21–24.'
    },
    {
      id: 'age_25_34',
      name: 'Age 25–34',
      description: 'Customers with DOB indicating age 25–34.'
    },
    {
      id: 'age_35_44',
      name: 'Age 35–44',
      description: 'Customers with DOB indicating age 35–44.'
    },
    {
      id: 'age_45_plus',
      name: 'Age 45+',
      description: 'Customers with DOB indicating age 45+.'
    },
    {
      id: 'vip',
      name: 'VIP (Top spenders)',
      description: 'Top spenders in the selected period (default top 200).'
    },
    {
      id: 'new',
      name: 'New customers',
      description: 'First seen purchasing in the last 30 days.'
    },
    {
      id: 'lapsed',
      name: 'Lapsed customers',
      description: 'Purchased before, but not in the last 60 days.'
    },
    {
      id: 'birthday_30',
      name: 'Birthday in next 30 days',
      description: 'Customers with a DOB and upcoming birthday window.'
    },
    {
      id: 'missing_dob',
      name: 'Missing DOB',
      description: 'Customers missing DOB (opportunity to collect for marketing).'
    },
    {
      id: 'missing_contact',
      name: 'Missing contact info',
      description: 'No email and no phone/mobile.'
    },
    {
      id: 'loyalty_enabled',
      name: 'Loyalty enabled',
      description: 'Customers opted into loyalty.'
    }
  ];
}

async function getSegmentCount(pool, segmentId, { days = 90, hasDailySnapshots = true } = {}) {
  const normalizedDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 90, 3650));

  if (segmentId === 'age_21_24') {
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int as count
        FROM customer_profiles
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 21 AND 24
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'age_25_34') {
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int as count
        FROM customer_profiles
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 25 AND 34
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'age_35_44') {
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int as count
        FROM customer_profiles
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) BETWEEN 35 AND 44
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'age_45_plus') {
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int as count
        FROM customer_profiles
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) >= 45
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'vip') {
    if (!hasDailySnapshots) return 0;
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int as count FROM (
          SELECT customer_id, SUM(total_spend)::numeric as spend
          FROM daily_customer_snapshots
          WHERE snapshot_date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
            AND customer_id IS NOT NULL
          GROUP BY customer_id
          ORDER BY spend DESC
          LIMIT 200
        ) t
      `,
      [normalizedDays]
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'new') {
    if (!hasDailySnapshots) return 0;
    const { rows } = await pool.query(
      `
        WITH first_seen AS (
          SELECT customer_id, MIN(snapshot_date) as first_date
          FROM daily_customer_snapshots
          WHERE customer_id IS NOT NULL AND transaction_count > 0
          GROUP BY customer_id
        )
        SELECT COUNT(*)::int as count
        FROM first_seen
        WHERE first_date >= CURRENT_DATE - INTERVAL '30 days'
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'lapsed') {
    if (!hasDailySnapshots) return 0;
    const { rows } = await pool.query(
      `
        WITH stats AS (
          SELECT customer_id, MAX(snapshot_date) as last_seen, SUM(total_spend)::numeric as lifetime_spend
          FROM daily_customer_snapshots
          WHERE customer_id IS NOT NULL
          GROUP BY customer_id
        )
        SELECT COUNT(*)::int as count
        FROM stats
        WHERE lifetime_spend > 0
          AND last_seen < CURRENT_DATE - INTERVAL '60 days'
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'birthday_30') {
    const { rows } = await pool.query(
      `
        WITH base AS (
          SELECT
            customer_id,
            date_of_birth,
            EXTRACT(MONTH FROM date_of_birth)::int as m,
            EXTRACT(DAY FROM date_of_birth)::int as d
          FROM customer_profiles
          WHERE date_of_birth IS NOT NULL
        ),
        year_calc AS (
          SELECT
            customer_id,
            date_of_birth,
            m,
            d,
            EXTRACT(YEAR FROM CURRENT_DATE)::int as y,
            CASE
              WHEN (EXTRACT(YEAR FROM CURRENT_DATE)::int % 4 = 0 AND (EXTRACT(YEAR FROM CURRENT_DATE)::int % 100 <> 0 OR EXTRACT(YEAR FROM CURRENT_DATE)::int % 400 = 0))
              THEN true ELSE false
            END as leap
          FROM base
        ),
        this_year AS (
          SELECT
            customer_id,
            CASE
              WHEN m = 2 AND d = 29 AND leap = false THEN make_date(y, 2, 28)
              ELSE make_date(y, m, d)
            END as bday_this_year
          FROM year_calc
        ),
        next_bday AS (
          SELECT
            customer_id,
            CASE
              WHEN bday_this_year < CURRENT_DATE THEN (bday_this_year + INTERVAL '1 year')::date
              ELSE bday_this_year
            END as next_birthday
          FROM this_year
        )
        SELECT COUNT(*)::int as count
        FROM next_bday
        WHERE next_birthday <= CURRENT_DATE + INTERVAL '30 days'
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'missing_dob') {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as count FROM customer_profiles WHERE date_of_birth IS NULL`
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'missing_contact') {
    const { rows } = await pool.query(
      `
        SELECT COUNT(*)::int as count
        FROM customer_profiles
        WHERE (email IS NULL OR email = '')
          AND (mobile IS NULL OR mobile = '')
          AND (phone IS NULL OR phone = '')
      `
    );
    return rows[0]?.count ?? 0;
  }

  if (segmentId === 'loyalty_enabled') {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as count FROM customer_profiles WHERE enable_loyalty IS TRUE`
    );
    return rows[0]?.count ?? 0;
  }

  return 0;
}

async function listSegments(pool, { days = 90 } = {}) {
  await ensureMarketingTables(pool);
  const defs = segmentDefinitions();
  const { rows } = await pool.query(`SELECT to_regclass('public.daily_customer_snapshots') as daily_customer_snapshots`);
  const hasDailySnapshots = Boolean(rows?.[0]?.daily_customer_snapshots);
  const counts = await Promise.all(defs.map((seg) => getSegmentCount(pool, seg.id, { days, hasDailySnapshots })));
  return defs.map((seg, idx) => ({ ...seg, count: counts[idx] }));
}

async function listSegmentCustomers(pool, segmentId, { days = 90, limit = 100, offset = 0 } = {}) {
  await ensureMarketingTables(pool);

  const normalizedDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 90, 3650));
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  const normalizedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  const { rows: snapshotRows } = await pool.query(`SELECT to_regclass('public.daily_customer_snapshots') as daily_customer_snapshots`);
  const hasDailySnapshots = Boolean(snapshotRows?.[0]?.daily_customer_snapshots);

  if (segmentId === 'age_21_24' || segmentId === 'age_25_34' || segmentId === 'age_35_44' || segmentId === 'age_45_plus') {
    let whereClause = '';
    if (segmentId === 'age_21_24') whereClause = `BETWEEN 21 AND 24`;
    if (segmentId === 'age_25_34') whereClause = `BETWEEN 25 AND 34`;
    if (segmentId === 'age_35_44') whereClause = `BETWEEN 35 AND 44`;
    if (segmentId === 'age_45_plus') whereClause = `>= 45`;

    const { rows } = await pool.query(
      `
        SELECT
          customer_id,
          name,
          email,
          mobile,
          phone,
          date_of_birth,
          EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth))::int as age_years,
          physical_city as city,
          physical_postcode as zip
        FROM customer_profiles
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, date_of_birth)) ${whereClause}
        ORDER BY age_years ASC, synced_at DESC
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'vip') {
    if (!hasDailySnapshots) return { customers: [] };
    const { rows } = await pool.query(
      `
        WITH spenders AS (
          SELECT customer_id, SUM(total_spend)::numeric as spend
          FROM daily_customer_snapshots
          WHERE snapshot_date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
            AND customer_id IS NOT NULL
          GROUP BY customer_id
        )
        SELECT
          p.customer_id,
          p.name,
          p.email,
          p.mobile,
          p.phone,
          p.enable_loyalty,
          p.loyalty_balance,
          s.spend::float as period_spend
        FROM spenders s
        JOIN customer_profiles p ON p.customer_id = s.customer_id
        ORDER BY s.spend DESC
        LIMIT $2 OFFSET $3
      `,
      [normalizedDays, normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'new') {
    if (!hasDailySnapshots) return { customers: [] };
    const { rows } = await pool.query(
      `
        WITH first_seen AS (
          SELECT customer_id, MIN(snapshot_date) as first_date
          FROM daily_customer_snapshots
          WHERE customer_id IS NOT NULL AND transaction_count > 0
          GROUP BY customer_id
        )
        SELECT
          p.customer_id,
          p.name,
          p.email,
          p.mobile,
          p.phone,
          fs.first_date
        FROM first_seen fs
        JOIN customer_profiles p ON p.customer_id = fs.customer_id
        WHERE fs.first_date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY fs.first_date DESC
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'lapsed') {
    if (!hasDailySnapshots) return { customers: [] };
    const { rows } = await pool.query(
      `
        WITH stats AS (
          SELECT customer_id, MAX(snapshot_date) as last_seen, SUM(total_spend)::numeric as lifetime_spend
          FROM daily_customer_snapshots
          WHERE customer_id IS NOT NULL
          GROUP BY customer_id
        )
        SELECT
          p.customer_id,
          p.name,
          p.email,
          p.mobile,
          p.phone,
          p.enable_loyalty,
          p.loyalty_balance,
          stats.last_seen,
          stats.lifetime_spend::float as lifetime_spend
        FROM stats
        JOIN customer_profiles p ON p.customer_id = stats.customer_id
        WHERE stats.lifetime_spend > 0
          AND stats.last_seen < CURRENT_DATE - INTERVAL '60 days'
        ORDER BY stats.last_seen DESC
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'birthday_30') {
    const { rows } = await pool.query(
      `
        WITH base AS (
          SELECT
            customer_id,
            name,
            email,
            mobile,
            phone,
            date_of_birth,
            EXTRACT(MONTH FROM date_of_birth)::int as m,
            EXTRACT(DAY FROM date_of_birth)::int as d
          FROM customer_profiles
          WHERE date_of_birth IS NOT NULL
        ),
        year_calc AS (
          SELECT
            *,
            EXTRACT(YEAR FROM CURRENT_DATE)::int as y,
            CASE
              WHEN (EXTRACT(YEAR FROM CURRENT_DATE)::int % 4 = 0 AND (EXTRACT(YEAR FROM CURRENT_DATE)::int % 100 <> 0 OR EXTRACT(YEAR FROM CURRENT_DATE)::int % 400 = 0))
              THEN true ELSE false
            END as leap
          FROM base
        ),
        this_year AS (
          SELECT
            customer_id,
            name,
            email,
            mobile,
            phone,
            date_of_birth,
            CASE
              WHEN m = 2 AND d = 29 AND leap = false THEN make_date(y, 2, 28)
              ELSE make_date(y, m, d)
            END as bday_this_year
          FROM year_calc
        ),
        next_bday AS (
          SELECT
            *,
            CASE
              WHEN bday_this_year < CURRENT_DATE THEN (bday_this_year + INTERVAL '1 year')::date
              ELSE bday_this_year
            END as next_birthday
          FROM this_year
        )
        SELECT
          customer_id,
          name,
          email,
          mobile,
          phone,
          date_of_birth,
          next_birthday
        FROM next_bday
        WHERE next_birthday <= CURRENT_DATE + INTERVAL '30 days'
        ORDER BY next_birthday ASC
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'missing_dob') {
    const { rows } = await pool.query(
      `
        SELECT customer_id, name, email, mobile, phone
        FROM customer_profiles
        WHERE date_of_birth IS NULL
        ORDER BY synced_at DESC
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'missing_contact') {
    const { rows } = await pool.query(
      `
        SELECT customer_id, name, email, mobile, phone
        FROM customer_profiles
        WHERE (email IS NULL OR email = '')
          AND (mobile IS NULL OR mobile = '')
          AND (phone IS NULL OR phone = '')
        ORDER BY synced_at DESC
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  if (segmentId === 'loyalty_enabled') {
    const { rows } = await pool.query(
      `
        SELECT customer_id, name, email, mobile, phone, loyalty_balance::float as loyalty_balance, year_to_date::float as year_to_date
        FROM customer_profiles
        WHERE enable_loyalty IS TRUE
        ORDER BY loyalty_balance DESC NULLS LAST
        LIMIT $1 OFFSET $2
      `,
      [normalizedLimit, normalizedOffset]
    );
    return { customers: rows };
  }

  return { customers: [] };
}

module.exports = {
  ensureMarketingTables,
  syncCustomerProfiles,
  getMarketingHealth,
  getMarketingSummary,
  listSegments,
  listSegmentCustomers,
  segmentDefinitions
};
