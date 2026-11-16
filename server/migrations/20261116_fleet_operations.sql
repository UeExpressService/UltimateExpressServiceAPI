-- Additive tables; existing accounts, bookings and fleet records are kept.
-- The application also creates these tables on first use.
CREATE TABLE IF NOT EXISTS driver_shifts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, driver_id BIGINT UNSIGNED NOT NULL,
        work_date DATE NOT NULL, time_in TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, time_out TIMESTAMP NULL,
        recorded_in_by BIGINT UNSIGNED NOT NULL, recorded_out_by BIGINT UNSIGNED NULL,
        UNIQUE KEY driver_day (driver_id, work_date), INDEX open_shifts (driver_id, time_out)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supervisor_booking_reviews (
        service_request_id BIGINT UNSIGNED PRIMARY KEY, sent_by BIGINT UNSIGNED NOT NULL,
        sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_version CHAR(64) NOT NULL,
        reviewed_by BIGINT UNSIGNED NULL, reviewed_at TIMESTAMP NULL, reviewed_version CHAR(64) NULL,
        notes VARCHAR(2000) NOT NULL DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
