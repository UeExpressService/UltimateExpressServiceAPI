-- Additive change. Role edits increment this version to revoke old sessions.
ALTER TABLE users ADD COLUMN session_version INT UNSIGNED NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS service_request_payment_schedules (
    service_request_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    due_date DATE NOT NULL, notes VARCHAR(1000) NOT NULL DEFAULT '',
    scheduled_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX payment_due_date (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
