require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
const { escape } = require('mysql2');
const bcrypt = require('bcryptjs');

const columns = [
    'id',
    'name',
    'email',
    'password',
    'role',
    'company',
    'phone',
    'address',
    'employee_id',
    'department',
    'verified',
    'must_change_password',
    'created_at'
];
const requiredColumns = ['id', 'name', 'email', 'password', 'role'];
const defaults = {
    company: 'NULL',
    phone: 'NULL',
    address: 'NULL',
    employee_id: 'NULL',
    department: 'NULL',
    verified: '1',
    must_change_password: '0',
    created_at: 'CURRENT_TIMESTAMP'
};

function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function exportAccounts() {
    const outputPath = path.resolve(
        process.argv[2] || path.join(__dirname, 'ultimate-express-accounts.sql')
    );
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const [sourceColumns] = await connection.query('SHOW COLUMNS FROM `users`');
        const availableColumns = new Set(sourceColumns.map(column => column.Field));
        const missingRequired = requiredColumns.filter(column => !availableColumns.has(column));
        if (missingRequired.length > 0) {
            throw new Error(`The source users table is missing required columns: ${missingRequired.join(', ')}.`);
        }
        const selectColumns = columns.map(column => availableColumns.has(column)
            ? `\`${column}\``
            : `${defaults[column]} AS \`${column}\``);
        const [accounts] = await connection.query(
            `SELECT ${selectColumns.join(', ')}
             FROM users
             ORDER BY id`
        );
        if (accounts.length === 0) {
            throw new Error('No accounts were found; no SQL export was written.');
        }

        const inserts = [];
        for (const account of accounts) {
            if (!isBcryptHash(account.password)) {
                account.password = await bcrypt.hash(String(account.password ?? ''), 12);
            }
            const values = columns.map(column => escape(account[column])).join(', ');
            inserts.push(
                `INSERT INTO \`users\` (${columns.map(column => `\`${column}\``).join(', ')}) VALUES (${values});`
            );
        }

        const sql = [
            '-- Sensitive account export from Ultimate Express.',
            '-- Contains personal data and password hashes. Keep private and delete after import.',
            'SET NAMES utf8mb4;',
            'START TRANSACTION;',
            ...inserts,
            'COMMIT;',
            ''
        ].join('\n');
        await fs.writeFile(outputPath, sql, { encoding: 'utf8', flag: 'wx' });
        console.log(`Exported ${accounts.length} accounts to ${outputPath}`);
        console.log('The SQL file contains sensitive account data. Keep it private and delete it after import.');
    } finally {
        await connection.end();
    }
}

exportAccounts().catch(error => {
    console.error('Unable to export accounts:', error.message);
    process.exitCode = 1;
});
