#!/usr/bin/env node
/**
 * Create a super_admin user.
 * 
 * Usage:
 *   node seeders/create-super-admin.js
 *   node seeders/create-super-admin.js --email admin@example.com --password mypass123 --firstName John --lastName Doe
 * 
 * If no arguments provided, uses defaults from environment or built-in defaults.
 */
require('dotenv').config();
const { sequelize, User } = require('../models');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    opts[key] = args[i + 1];
  }
  return opts;
};

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ DB connected.');

    const opts = parseArgs();
    const email = opts.email || process.env.SUPER_ADMIN_EMAIL || 'superadmin@carribu.io';
    const password = opts.password || process.env.SUPER_ADMIN_PASSWORD || 'super123';
    const firstName = opts.firstName || process.env.SUPER_ADMIN_FIRST_NAME || 'Super';
    const lastName = opts.lastName || process.env.SUPER_ADMIN_LAST_NAME || 'Admin';
    const phone = opts.phone || process.env.SUPER_ADMIN_PHONE || '+254700000000';

    // Check if already exists
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      console.log(`⚠️  Super admin already exists: ${email} (id: ${existing.id})`);
      console.log('   Updating password...');
      existing.passwordHash = password;
      await existing.save();
      console.log('✅ Password updated.');
    } else {
      const user = await User.create({
        email,
        passwordHash: password,
        firstName,
        lastName,
        role: 'super_admin',
        phone,
      });
      console.log(`✅ Super admin created: ${email} (id: ${user.id})`);
    }

    console.log(`\n📋 Login credentials:`);
    console.log(`   Email:    ${email}`);
    console.log(`   Password: ${password}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  }
})();
