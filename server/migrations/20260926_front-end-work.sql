ALTER TABLE trucks
    ADD COLUMN third_party TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE service_requests
    ADD COLUMN assigned_driver_id INT NULL,
    ADD COLUMN assigned_truck_id INT NULL;

CREATE TABLE IF NOT EXISTS customer_account_requests (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    company VARCHAR(255) NULL,
    phone VARCHAR(64) NULL,
    message TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_customer_account_requests_status (status),
    INDEX idx_customer_account_requests_email (email)
);
