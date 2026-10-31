-- Fresh MySQL schema for a new Railway database.
-- Run once against an empty database. This includes the changes from all
-- server/migrations/*.sql files; do not apply those migrations afterward.

SET NAMES utf8mb4;

CREATE TABLE users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL,
    company VARCHAR(255) NULL,
    phone VARCHAR(64) NULL,
    address VARCHAR(500) NULL,
    employee_id VARCHAR(100) NULL,
    department VARCHAR(100) NULL,
    verified TINYINT(1) NOT NULL DEFAULT 0,
    verification_token VARCHAR(255) NULL,
    verification_expires_at DATETIME NULL,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email),
    UNIQUE KEY uq_users_verification_token (verification_token),
    INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE drivers (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    license_number VARCHAR(100) NOT NULL,
    phone VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'available',
    email VARCHAR(255) NULL,
    experience VARCHAR(100) NULL,
    notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_drivers_license_number (license_number),
    INDEX idx_drivers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE trucks (
    id INT NOT NULL AUTO_INCREMENT,
    type VARCHAR(255) NOT NULL,
    license_plate VARCHAR(100) NOT NULL,
    daily_rate DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'available',
    third_party TINYINT(1) NOT NULL DEFAULT 0,
    capacity VARCHAR(64) NULL,
    location VARCHAR(255) NULL,
    notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_trucks_license_plate (license_plate),
    INDEX idx_trucks_status (status),
    INDEX idx_trucks_third_party (third_party)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE service_requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    customer_id BIGINT UNSIGNED NULL,
    cargo_type VARCHAR(100) NULL,
    cargo_weight VARCHAR(100) NULL,
    special_requirements TEXT NULL,
    pickup_location VARCHAR(500) NULL,
    delivery_location VARCHAR(500) NULL,
    pickup_date DATE NULL,
    preferred_time VARCHAR(100) NULL,
    truck_type VARCHAR(255) NULL,
    contact_person VARCHAR(255) NULL,
    contact_phone VARCHAR(64) NULL,
    contact_email VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'new',
    assigned_driver_id INT NULL,
    assigned_truck_id INT NULL,
    quoted_amount DECIMAL(12, 2) NULL,
    paid_amount DECIMAL(12, 2) NULL,
    paid_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_service_requests_customer_created (customer_id, created_at),
    INDEX idx_service_requests_status_created (status, created_at),
    INDEX idx_service_requests_driver (assigned_driver_id),
    INDEX idx_service_requests_truck (assigned_truck_id),
    CONSTRAINT fk_service_requests_customer
        FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_service_requests_driver
        FOREIGN KEY (assigned_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
    CONSTRAINT fk_service_requests_truck
        FOREIGN KEY (assigned_truck_id) REFERENCES trucks(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_account_requests (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE partners (
    id INT NOT NULL AUTO_INCREMENT,
    company VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255) NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(64) NULL,
    partnership_type VARCHAR(100) NULL,
    contract_duration VARCHAR(100) NULL,
    agreement_details TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_partners_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_code_challenges (
    challenge_id CHAR(36) NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    code_hash CHAR(64) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (challenge_id),
    INDEX idx_login_code_user_created (user_id, created_at),
    INDEX idx_login_code_expiry (expires_at),
    CONSTRAINT fk_login_code_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_password_resets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
