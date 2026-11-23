// Uses the temporary database from test-password-resets.js.
const assert = require('node:assert/strict');

module.exports = async function testReportAmounts({ connection, base, sessions }) {
    const report = (year, role = 'manager') => fetch(`${base}/manager/report?year=${year}`, {
        headers: sessions[role] ? { Authorization: `Bearer ${sessions[role]}` } : {}
    });
    for (const [role, status] of [['anonymous', 401], ['customer', 403], ['dispatcher', 403], ['supervisor', 403]]) {
        assert.equal((await report(2030, role)).status, status);
    }
    for (const year of ['bad', '2026.5', '0', '2101', '']) assert.equal((await report(year)).status, 400);
    const empty = await (await report(2030)).json();
    assert.deepEqual(empty.calculatedAmounts, {
        confirmed_quotes: '0.00', confirmed_quote_count: 0, unpaid_quotes: '0.00', unpaid_quote_count: 0,
        recorded_payments: '0.00', paid_bookings: 0, average_paid_amount: null
    });
    const insert = (status, quote, paid, pickup, created, paidAt) => connection.execute(`
        INSERT INTO service_requests (customer_id,status,quoted_amount,paid_amount,pickup_date,created_at,paid_at)
        VALUES (3,?,?,?,?,?,?)`, [status, quote, paid, pickup, created, paidAt]);
    await insert('approved', '1000.10', null, '2031-01-01', '2030-12-01', null);
    await insert('ongoing', '2000.20', null, null, '2031-12-31 23:59:59', null);
    await insert('completed', '3000.30', '2900.00', '2031-12-31', '2031-01-01', '2032-01-01');
    await insert('completed', '4000.40', '4500.00', '2030-12-31', '2031-01-01', '2031-01-01');
    for (const status of ['pending', 'new', 'cancelled']) await insert(status, '9999.99', null, '2031-06-01', '2031-01-01', null);
    await insert('approved', null, null, '2031-06-01', '2031-01-01', null);
    await insert('ongoing', '0', null, '2031-06-01', '2031-01-01', null);
    const amounts = (await (await report(2031)).json()).calculatedAmounts;
    assert.deepEqual(amounts, {
        confirmed_quotes: '6000.60', confirmed_quote_count: 3, unpaid_quotes: '3000.30', unpaid_quote_count: 2,
        recorded_payments: '4500.00', paid_bookings: 1, average_paid_amount: '4500.00'
    }, 'Quotes use pickup/creation year; payments use paid_at; unpaid quotes are not quotes minus payments');
    assert.equal((await (await report(2032)).json()).calculatedAmounts.recorded_payments, '2900.00');
    await insert('completed', '0.10', '0.01', '2033-01-01', '2033-01-01', '2033-01-01');
    await insert('completed', '0.10', '0.02', '2033-01-01', '2033-01-01', '2033-12-31 23:59:59');
    const rounded = (await (await report(2033)).json()).calculatedAmounts;
    assert.equal(rounded.recorded_payments, '0.03');
    assert.equal(rounded.average_paid_amount, '0.02', 'Money average rounds half a cent using decimal arithmetic');
    await connection.query('DELETE FROM service_requests WHERE YEAR(created_at) BETWEEN 2030 AND 2033');
    console.log('Manager calculated amounts passed: role access, year validation, empty year, status exclusions, saved quotes, cross-year payments, date fallback, decimal rounding.');
};
