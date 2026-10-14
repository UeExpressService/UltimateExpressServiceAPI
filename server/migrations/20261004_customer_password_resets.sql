CREATE TABLE customer_password_resets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_customer_password_reset_token (token_hash),
    INDEX idx_customer_password_reset_user_created (user_id, created_at),
    INDEX idx_customer_password_reset_expiry (expires_at),
    CONSTRAINT fk_customer_password_reset_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
