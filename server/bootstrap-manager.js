require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function bootstrapManager() {
    const name = String(process.env.BOOTSTRAP_MANAGER_NAME || '').trim();
    const email = String(process.env.BOOTSTRAP_MANAGER_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.BOOTSTRAP_MANAGER_PASSWORD || '');
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Set a manager name and valid BOOTSTRAP_MANAGER_EMAIL.');
    }
    if (password.length < 12 || password.length > 128) {
        throw new Error('Set BOOTSTRAP_MANAGER_PASSWORD to a unique password between 12 and 128 characters.');
    }

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const [existing] = await connection.execute(
            'SELECT id FROM users WHERE email = ? LIMIT 1',
            [email]
        );
        if (existing.length > 0) {
            throw new Error('An account already exists with that email. No account was changed.');
        }
        const passwordHash = await bcrypt.hash(password, 12);
        await connection.execute(
            `INSERT INTO users (name, email, password, role, verified, must_change_password, department)
             VALUES (?, ?, ?, 'manager', 1, 1, 'Management')`,
            [name, email, passwordHash]
        );
        console.log(`Bootstrap Manager account created for ${email}. Remove the bootstrap password from the environment after use.`);
    } finally {
        await connection.end();
    }
}

bootstrapManager().catch(error => {
    console.error('Unable to bootstrap Manager account:', error.message);
    process.exitCode = 1;
});
