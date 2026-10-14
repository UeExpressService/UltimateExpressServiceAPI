ALTER TABLE service_requests
    ADD COLUMN paid_amount DECIMAL(12, 2) NULL,
    ADD COLUMN paid_at DATETIME NULL;
