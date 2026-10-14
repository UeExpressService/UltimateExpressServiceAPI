require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const testAccounts = [
    {
        name: 'Test Customer',
        email: 'customer.test@ultimateexpress.local',
        password: 'Test123!',
        role: 'customer',
        company: 'Test Customer Co.',
        phone: '09170000001'
    },
    {
        name: 'Test Dispatcher',
        email: 'dispatcher.test@ultimateexpress.local',
        password: 'Test123!',
        role: 'dispatcher',
        department: 'Dispatch',
        employee_id: 'TEST-DISPATCHER'
    },
    {
        name: 'Test Supervisor',
        email: 'supervisor.test@ultimateexpress.local',
        password: 'Test123!',
        role: 'supervisor',
        department: 'Fleet Operations',
        employee_id: 'TEST-SUPERVISOR'
    },
    {
        name: 'Test Manager',
        email: 'manager.test@ultimateexpress.local',
        password: 'Test123!',
        role: 'manager',
        department: 'Management',
        employee_id: 'TEST-MANAGER'
    }
];

const testDrivers = [
    { name: 'Test Driver One', license_number: 'TEST-LIC-001', phone: '09170000011', email: 'driver.one.test@ultimateexpress.local', experience: '5 years', notes: 'Demo driver', status: 'available' },
    { name: 'Test Driver Two', license_number: 'TEST-LIC-002', phone: '09170000012', email: 'driver.two.test@ultimateexpress.local', experience: '8 years', notes: 'Demo driver', status: 'busy' }
];

const testTrucks = [
    { type: '10-Wheeler Wing Van', license_plate: 'TEST-TRK-001', daily_rate: 12000, capacity: '15,000 kg', location: 'Makati City', notes: 'Demo fleet truck', third_party: false, status: 'available' },
    { type: '6-Wheeler Closed Van', license_plate: 'TEST-TRK-002', daily_rate: 8500, capacity: '8,000 kg', location: 'Cebu City', notes: 'Demo partner truck', third_party: true, status: 'busy' }
];

const testRequests = [
    {
        cargo_type: 'Office Supplies',
        cargo_weight: '500 kg',
        special_requirements: 'TEST-ORDER-ONGOING - Handle with care',
        pickup_location: 'Makati City, Metro Manila',
        delivery_location: 'Cebu City, Cebu',
        pickup_date: '2026-09-20',
        preferred_time: '09:00 AM',
        truck_type: '10-Wheeler Wing Van',
        contact_person: 'Test Customer',
        contact_phone: '09170000001',
        contact_email: 'customer.test@ultimateexpress.local',
        status: 'ongoing',
        paid_amount: null,
        paid_at: null
    },
    {
        cargo_type: 'Retail Merchandise',
        cargo_weight: '250 kg',
        special_requirements: 'TEST-ORDER-PENDING - Standard delivery',
        pickup_location: 'Quezon City, Metro Manila',
        delivery_location: 'Davao City, Davao del Sur',
        pickup_date: '2026-09-22',
        preferred_time: '01:00 PM',
        truck_type: '6-Wheeler Closed Van',
        contact_person: 'Test Customer',
        contact_phone: '09170000001',
        contact_email: 'customer.test@ultimateexpress.local',
        status: 'pending',
        paid_amount: null,
        paid_at: null
    },
    {
        cargo_type: 'Machinery Parts',
        cargo_weight: '800 kg',
        special_requirements: 'TEST-ORDER-COMPLETED - Delivered successfully',
        pickup_location: 'Batangas City, Batangas',
        delivery_location: 'Pasig City, Metro Manila',
        pickup_date: '2026-09-10',
        preferred_time: '08:00 AM',
        truck_type: '6-Wheeler Closed Van',
        contact_person: 'Test Customer',
        contact_phone: '09170000001',
        contact_email: 'customer.test@ultimateexpress.local',
        status: 'completed',
        paid_amount: 38500,
        paid_at: '2026-09-10 12:00:00'
    }
];

async function seedTestAccounts() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        for (const account of testAccounts) {
            await connection.execute(
                `INSERT INTO users
                    (name, email, password, role, company, phone, employee_id, department, verified)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    password = VALUES(password),
                    role = VALUES(role),
                    company = VALUES(company),
                    phone = VALUES(phone),
                    employee_id = VALUES(employee_id),
                    department = VALUES(department),
                    verified = 1`,
                [
                    account.name,
                    account.email,
                    await bcrypt.hash(account.password, 12),
                    account.role,
                    account.company || null,
                    account.phone || null,
                    account.employee_id || null,
                    account.department || null
                ]
            );
            console.log(`Seeded ${account.role}: ${account.email}`);
        }

        const [customers] = await connection.execute(
            'SELECT id FROM users WHERE email = ? LIMIT 1',
            ['customer.test@ultimateexpress.local']
        );
        if (customers.length === 0) throw new Error('Test customer account was not found');
        const customerId = customers[0].id;

        for (const driver of testDrivers) {
            await connection.execute(
                `INSERT INTO drivers (name, license_number, phone, email, experience, notes, status)
                 SELECT ?, ?, ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM drivers WHERE license_number = ?)`,
                [driver.name, driver.license_number, driver.phone, driver.email, driver.experience, driver.notes, driver.status, driver.license_number]
            );
            await connection.execute(
                'UPDATE drivers SET name = ?, phone = ?, email = ?, experience = ?, notes = ?, status = ? WHERE license_number = ?',
                [driver.name, driver.phone, driver.email, driver.experience, driver.notes, driver.status, driver.license_number]
            );
            console.log(`Seeded driver: ${driver.name}`);
        }

        for (const truck of testTrucks) {
            await connection.execute(
                `INSERT INTO trucks (type, license_plate, daily_rate, capacity, location, notes, third_party, status)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM trucks WHERE license_plate = ?)`,
                [truck.type, truck.license_plate, truck.daily_rate, truck.capacity, truck.location, truck.notes, truck.third_party, truck.status, truck.license_plate]
            );
            await connection.execute(
                'UPDATE trucks SET type = ?, daily_rate = ?, capacity = ?, location = ?, notes = ?, third_party = ?, status = ? WHERE license_plate = ?',
                [truck.type, truck.daily_rate, truck.capacity, truck.location, truck.notes, truck.third_party, truck.status, truck.license_plate]
            );
            console.log(`Seeded truck: ${truck.license_plate}`);
        }

        for (const request of testRequests) {
            await connection.execute(
                `INSERT INTO service_requests
                    (customer_id, cargo_type, cargo_weight, special_requirements,
                     pickup_location, delivery_location, pickup_date, preferred_time,
                     truck_type, contact_person, contact_phone, contact_email, status, paid_amount, paid_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (
                    SELECT 1 FROM service_requests WHERE special_requirements = ?
                 )`,
                [
                    customerId,
                    request.cargo_type,
                    request.cargo_weight,
                    request.special_requirements,
                    request.pickup_location,
                    request.delivery_location,
                    request.pickup_date,
                    request.preferred_time,
                    request.truck_type,
                    request.contact_person,
                    request.contact_phone,
                    request.contact_email,
                    request.status,
                    request.paid_amount,
                    request.paid_at,
                    request.special_requirements
                ]
            );
            await connection.execute(
                `UPDATE service_requests
                 SET status = ?, customer_id = ?, pickup_date = ?, pickup_location = ?, delivery_location = ?,
                     paid_amount = ?, paid_at = ?
                 WHERE special_requirements = ?`,
                [request.status, customerId, request.pickup_date, request.pickup_location, request.delivery_location, request.paid_amount, request.paid_at, request.special_requirements]
            );
            console.log(`Seeded order: ${request.special_requirements.split(' - ')[0]}`);
        }

        await connection.execute(
            `INSERT INTO partners (company, contact_person, partnership_type, contract_duration, agreement_details)
             SELECT ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM partners WHERE company = ?)`,
            ['Test Logistics Partner', 'Test Partner Contact', 'Corporate', '12 months', 'TEST-PARTNER', 'Test Logistics Partner']
        );
        console.log('Seeded partner: Test Logistics Partner');
    } finally {
        await connection.end();
    }
}

seedTestAccounts().catch(error => {
    console.error('Unable to seed test accounts:', error.message);
    process.exitCode = 1;
});
