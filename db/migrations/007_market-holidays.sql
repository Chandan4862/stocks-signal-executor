-- Market holidays table: tracks NSE/BSE non-trading days.
-- Used by HolidayService to skip scheduled trading on holidays
-- and send Telegram notifications.

-- UP

CREATE TABLE IF NOT EXISTS market_holidays (
  id            BIGSERIAL PRIMARY KEY,
  holiday_date  DATE NOT NULL UNIQUE,
  day_name      TEXT NOT NULL,
  description   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_holidays_date ON market_holidays (holiday_date);

-- Seed: 2026 NSE holidays
INSERT INTO market_holidays (holiday_date, day_name, description) VALUES
  ('2026-01-15', 'Thursday',  'Municipal Corporation Election in Maharashtra'),
  ('2026-01-26', 'Monday',    'Republic Day'),
  ('2026-02-19', 'Thursday',  'Chhatrapati Shivaji Maharaj Jayanti'),
  ('2026-03-03', 'Tuesday',   'Holi (Second Day)'),
  ('2026-03-19', 'Thursday',  'Gudhi Padwa'),
  ('2026-03-26', 'Thursday',  'Ram Navami'),
  ('2026-03-31', 'Tuesday',   'Mahavir Jayanti'),
  ('2026-04-01', 'Wednesday', 'Annual Bank Closing'),
  ('2026-04-03', 'Friday',    'Good Friday'),
  ('2026-04-14', 'Tuesday',   'Dr. Babasaheb Ambedkar Jayanti'),
  ('2026-05-01', 'Friday',    'Maharashtra Din / Buddha Pournima'),
  ('2026-05-28', 'Thursday',  'Bakri ID (Id-Uz-Zuha)'),
  ('2026-06-26', 'Friday',    'Muharram'),
  ('2026-08-26', 'Wednesday', 'Id-E-Milad'),
  ('2026-09-14', 'Monday',    'Ganesh Chaturthi'),
  ('2026-10-02', 'Friday',    'Mahatma Gandhi Jayanti'),
  ('2026-10-20', 'Tuesday',   'Dussehra'),
  ('2026-11-10', 'Tuesday',   'Diwali (Bali Pratipada)'),
  ('2026-11-24', 'Tuesday',   'Guru Nanak Jayanti'),
  ('2026-12-25', 'Friday',    'Christmas')
ON CONFLICT (holiday_date) DO NOTHING;

-- DOWN

-- DROP TABLE IF EXISTS market_holidays;
