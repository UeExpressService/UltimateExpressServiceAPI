ALTER TABLE users
    ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE service_requests
    ADD COLUMN quoted_amount DECIMAL(12, 2) NULL;

CREATE TABLE manager_audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    actor_user_id INT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NULL,
    summary VARCHAR(500) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_manager_audit_created (created_at),
    INDEX idx_manager_audit_actor_created (actor_user_id, created_at)
);
