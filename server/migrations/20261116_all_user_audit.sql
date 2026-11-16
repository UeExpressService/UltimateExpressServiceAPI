-- Existing entries remain in the same table. The application adds missing columns safely.
ALTER TABLE manager_audit_logs
    ADD COLUMN actor_name VARCHAR(255) NULL,
    ADD COLUMN actor_email VARCHAR(255) NULL,
    ADD COLUMN actor_role VARCHAR(32) NULL,
    ADD COLUMN outcome VARCHAR(16) NOT NULL DEFAULT 'success',
    ADD COLUMN http_status SMALLINT UNSIGNED NULL,
    ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'server';

-- Legacy events can only use identity information still available at upgrade time.
UPDATE manager_audit_logs log JOIN users account ON account.id=log.actor_user_id
SET log.actor_name=COALESCE(log.actor_name,account.name),
    log.actor_email=COALESCE(log.actor_email,account.email),
    log.actor_role=COALESCE(log.actor_role,account.role)
WHERE log.actor_name IS NULL OR log.actor_email IS NULL OR log.actor_role IS NULL;
