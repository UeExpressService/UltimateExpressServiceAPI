-- Gmail reconnect storage. Tokens are encrypted by the application.
CREATE TABLE IF NOT EXISTS gmail_authorization (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    encrypted_refresh_token TEXT NOT NULL,
    sender_email VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gmail_authorization_states (
    state_hash CHAR(64) NOT NULL PRIMARY KEY,
    browser_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    INDEX idx_gmail_state_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
