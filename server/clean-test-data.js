require('dotenv').config();
const mysql = require('mysql2/promise');

async function cleanTestData() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        await connection.beginTransaction();
        await connection.execute(
            `DELETE FROM service_requests
             WHERE special_requirements LIKE 'TEST-ORDER-%'`
        );
        await connection.execute(
            `UPDATE service_requests
             SET assigned_driver_id = NULL
             WHERE assigned_driver_id IN (
                SELECT id FROM drivers WHERE license_number LIKE 'TEST-LIC-%'
             )`
        );
        await connection.execute(
            `UPDATE service_requests
             SET assigned_truck_id = NULL
             WHERE assigned_truck_id IN (
                SELECT id FROM trucks WHERE license_plate LIKE 'TEST-TRK-%'
             )`
        );
        await connection.execute(
            `DELETE lc FROM login_code_challenges lc
             JOIN users u ON u.id = lc.user_id
             WHERE u.email IN (
                'customer.test@ultimateexpress.local',
                'dispatcher.test@ultimateexpress.local',
                'supervisor.test@ultimateexpress.local',
                'manager.test@ultimateexpress.local'
             )`
        );
        await connection.execute(
            `DELETE FROM users
             WHERE email IN (
                'customer.test@ultimateexpress.local',
                'dispatcher.test@ultimateexpress.local',
                'supervisor.test@ultimateexpress.local',
                'manager.test@ultimateexpress.local'
             )`
        );
        await connection.execute("DELETE FROM drivers WHERE license_number LIKE 'TEST-LIC-%'");
        await connection.execute("DELETE FROM trucks WHERE license_plate LIKE 'TEST-TRK-%'");
        await connection.execute("DELETE FROM partners WHERE company = 'Test Logistics Partner'");
        await connection.commit();
        console.log('Removed the marked Ultimate Express test accounts and demo records.');
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        await connection.end();
    }
}

cleanTestData().catch(error => {
    console.error('Unable to clean test data:', error.message);
    process.exitCode = 1;
});
