#!/usr/bin/env node
/**
 * Create one or more admin users.
 * 
 * Usage:
 *   # Single account (CLI args):
 *   node seeders/create-super-admin.js --email admin@example.com --password mypass --role super_admin
 * 
 *   # Multiple accounts (JSON env var):
 *   ADMIN_ACCOUNTS='[{"email":"a@b.com","password":"pass1","firstName":"A","lastName":"B","role":"super_admin"},{"email":"c@d.com","password":"pass2","firstName":"C","lastName":"D","role":"school_admin","schoolId":1}]'
 *   node seeders/create-super-admin.js
 * 
 *   # Default (single super_admin from env vars):
 *   SUPER_ADMIN_EMAIL=admin@carribu.io SUPER_ADMIN_PASSWORD=secret node seeders/create-super-admin.js
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

const createOrUpdateUser = async (account) => {
  const { email, password, firstName = 'Admin', lastName = 'User', role = 'super_admin', phone = null, schoolId = null } = account;

  const existing = await User.findOne({ where: { email } });
  if (existing) {
    console.log(`⚠️  User already exists: ${email} (id: ${existing.id}) — updating password`);
    existing.passwordHash = password;
    await existing.save();
  } else {
    const user = await User.create({
      email,
      passwordHash: password,
      firstName,
      lastName,
      role,
      phone,
      schoolId,
    });
    console.log(`✅ Created ${role}: ${email} (id: ${user.id})`);
  }
  console.log(`   📋 Email: ${email} | Password: ${password} | Role: ${role}`);
};

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ DB connected.\n');

    let accounts = [];

    // Option 1: ADMIN_ACCOUNTS env var (JSON array)
    if (process.env.ADMIN_ACCOUNTS) {
      accounts = JSON.parse(process.env.ADMIN_ACCOUNTS);
      console.log(`📦 Found ${accounts.length} accounts in ADMIN_ACCOUNTS env var\n`);
    }
    // Option 2: CLI args for a single account
    else {
      const opts = parseArgs();
      if (opts.email) {
        accounts = [{
          email: opts.email,
          password: opts.password || 'admin123',
          firstName: opts.firstName || 'Admin',
          lastName: opts.lastName || 'User',
          role: opts.role || 'super_admin',
          phone: opts.phone || null,
          schoolId: opts.schoolId ? parseInt(opts.schoolId) : null,
        }];
      }
      // Option 3: Default from individual env vars
      else {
        accounts = [{
          email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@carribu.io',
          password: process.env.SUPER_ADMIN_PASSWORD || 'super123',
          firstName: process.env.SUPER_ADMIN_FIRST_NAME || 'Super',
          lastName: process.env.SUPER_ADMIN_LAST_NAME || 'Admin',
          role: 'super_admin',
          phone: process.env.SUPER_ADMIN_PHONE || '+254700000000',
        }];
      }
    }

    for (const account of accounts) {
      await createOrUpdateUser(account);
    }

    console.log(`\n🎉 Done! ${accounts.length} account(s) processed.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  }
})();

