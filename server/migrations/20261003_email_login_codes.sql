CREATE TABLE login_code_challenges (
    challenge_id CHAR(36) NOT NULL,
    user_id INT NOT NULL,
    code_hash CHAR(64) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (challenge_id),
    INDEX idx_login_code_user_created (user_id, created_at),
    INDEX idx_login_code_expiry (expires_at)
);
