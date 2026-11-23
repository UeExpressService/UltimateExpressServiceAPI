// Make the reset table if an older database is missing it.
module.exports = function passwordResetStore(dbp) {
    let ready;
    return function ensurePasswordResetTable() {
        if (!ready) {
            ready = (async () => {
                const [columns] = await dbp.query("SHOW COLUMNS FROM users LIKE 'id'");
                const userIdType = columns[0]?.Type;
                // Match the user ID type. Older databases use INT and newer ones use BIGINT UNSIGNED.
                if (!/^(?:tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?(?: unsigned)?$/i.test(userIdType || '')) {
                    throw new Error('Unsupported users.id type for password-reset storage.');
                }
                await dbp.query(`CREATE TABLE IF NOT EXISTS customer_password_resets (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    user_id ${userIdType} NOT NULL,
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
                ) ENGINE=InnoDB`);
            })().catch(error => {
                ready = null; // Let the next request try again.
                throw error;
            });
        }
        return ready;
    };
};
