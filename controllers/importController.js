const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { User, Student, School, sequelize } = require('../models');
const { sendWelcomeWhatsApp } = require('../utils/whatsapp');

const generatePassword = () => crypto.randomBytes(4).toString('hex');

/**
 * Normalize phone number: strip spaces, ensure leading 0 or +254
 */
function normalizePhone(phone) {
  if (!phone) return null;
  phone = phone.trim();
  if (phone.toLowerCase().includes('not visible') || phone.toLowerCase().includes('unclear')) return null;
  // Take only the first number if multiple are listed
  phone = phone.split('/')[0].split('(')[0].trim();
  // Remove non-digit chars except leading +
  phone = phone.replace(/[^\d+]/g, '');
  if (!phone) return null;
  return phone;
}

/**
 * Generate a unique email from parent name for cases where no email exists in the CSV
 */
function generateEmail(name, schoolDomain) {
  const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '.');
  return `${sanitized}@${schoolDomain}`;
}

/**
 * Parse the CSV which has two formats:
 * Section 1: Parent Name, Phone Number, Child(ren), Grade/Class
 *   - Empty parent name means child belongs to previous parent
 * Section 2: Parent Name, Phone Number, Child 1, Grade, Child 2, Grade, Child 3, Grade
 */
function parseTransportCSV(content) {
  const records = parse(content, {
    skip_empty_lines: false,
    relax_column_count: true,
    trim: true,
  });

  const parents = []; // { name, phone, children: [{ name, grade }] }
  let currentParent = null;
  let section = 1;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    // Skip empty rows
    if (!row || row.every(cell => !cell || !cell.trim())) continue;

    // Detect header rows
    const firstCell = (row[0] || '').trim().toLowerCase();
    if (firstCell === 'parent name') {
      // Section 2 header has "Child 1" with a number, distinguishing from "Child(ren)"
      if (row.length > 4 && /child\s*\d/i.test((row[2] || '').trim())) {
        section = 2;
      }
      continue;
    }

    if (section === 1) {
      const parentName = (row[0] || '').trim();
      const phone = (row[1] || '').trim();
      const childName = (row[2] || '').trim();
      const grade = (row[3] || '').trim();

      if (parentName) {
        // New parent
        currentParent = { name: parentName, phone, children: [] };
        parents.push(currentParent);
      }

      if (childName && currentParent) {
        currentParent.children.push({ name: childName, grade });
      }
    } else {
      // Section 2: Parent Name, Phone, Child1, Grade1, Child2, Grade2, Child3, Grade3
      const parentName = (row[0] || '').trim();
      const phone = (row[1] || '').trim();

      if (!parentName) continue;

      currentParent = { name: parentName, phone, children: [] };
      parents.push(currentParent);

      // Parse child/grade pairs starting at index 2
      for (let j = 2; j < row.length; j += 2) {
        const childName = (row[j] || '').trim();
        const grade = (row[j + 1] || '').trim();
        if (childName) {
          currentParent.children.push({ name: childName, grade });
        }
      }
    }
  }

  return parents.filter(p => p.children.length > 0);
}

/**
 * Split a full name into firstName and lastName
 */
function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * POST /api/import/parents-students
 * Bulk import parents and students from a CSV file
 * Uses phone number as username, generates password, sends via WhatsApp
 */
exports.importParentsAndStudents = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required. Upload with field name "file".' });
    }

    const schoolId = req.user.schoolId;
    const schoolDomain = `school${schoolId}.carribu.local`;
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const parsedParents = parseTransportCSV(content);

    if (parsedParents.length === 0) {
      return res.status(400).json({ error: 'No valid parent/student data found in CSV.' });
    }

    const school = await School.findByPk(schoolId);
    const schoolName = school?.name || 'Your School';
    const sendWhatsApp = req.body.sendWhatsApp !== 'false'; // default true

    const results = {
      parentsCreated: 0,
      studentsCreated: 0,
      whatsappSent: 0,
      whatsappFailed: 0,
      skipped: [],
      errors: [],
      credentials: [], // returned so admin can see generated passwords
    };

    for (const parentData of parsedParents) {
      try {
        const { firstName, lastName } = splitName(parentData.name);
        const phone = normalizePhone(parentData.phone);
        // Use phone as username; email is generated placeholder for DB constraint
        const email = generateEmail(parentData.name, schoolDomain);

        // Check if parent already exists by phone or email
        let parent = null;
        if (phone) {
          parent = await User.findOne({ where: { phone }, transaction });
        }
        if (!parent) {
          parent = await User.findOne({ where: { email }, transaction });
        }

        let tempPassword = null;
        if (!parent) {
          tempPassword = generatePassword();
          parent = await User.create({
            schoolId,
            email,
            passwordHash: tempPassword,
            firstName,
            lastName,
            role: 'parent',
            phone,
          }, { transaction });
          results.parentsCreated++;
          results.credentials.push({
            name: parentData.name,
            username: phone || email,
            password: tempPassword,
            phone,
          });
        } else {
          results.skipped.push(`Parent "${parentData.name}" already exists (phone: ${phone})`);
        }

        // Create students
        for (const child of parentData.children) {
          const childNames = splitName(child.name);
          await Student.create({
            schoolId,
            parentId: parent.id,
            firstName: childNames.firstName,
            lastName: childNames.lastName,
            grade: child.grade || null,
          }, { transaction });
          results.studentsCreated++;
        }
      } catch (err) {
        results.errors.push(`Error processing parent "${parentData.name}": ${err.message}`);
      }
    }

    await transaction.commit();

    // Send WhatsApp messages after successful commit (non-blocking)
    if (sendWhatsApp) {
      for (const cred of results.credentials) {
        if (cred.phone) {
          try {
            const waResult = await sendWelcomeWhatsApp(
              cred.phone,
              cred.name.split(' ')[0],
              cred.username,
              cred.password,
              schoolName
            );
            if (waResult.sent) results.whatsappSent++;
            else results.whatsappFailed++;
          } catch {
            results.whatsappFailed++;
          }
        }
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.status(201).json({
      message: `Import complete. ${results.parentsCreated} parents and ${results.studentsCreated} students created. WhatsApp: ${results.whatsappSent} sent, ${results.whatsappFailed} failed.`,
      ...results,
    });
  } catch (err) {
    await transaction.rollback();
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/import/preview
 * Preview the parsed CSV data without importing
 */
exports.previewImport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required. Upload with field name "file".' });
    }

    const content = fs.readFileSync(req.file.path, 'utf-8');
    const parsedParents = parseTransportCSV(content);

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    const totalStudents = parsedParents.reduce((sum, p) => sum + p.children.length, 0);

    res.json({
      totalParents: parsedParents.length,
      totalStudents,
      parents: parsedParents.map(p => ({
        name: p.name,
        phone: normalizePhone(p.phone),
        children: p.children,
      })),
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
};
