const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { User, ParentSchool, Student, sequelize } = require('../models');
const { Op } = require('sequelize');
const { normalizePhoneE164 } = require('../utils/phone');

// Random placeholder hash for pending accounts; parents set their own password in the app
const generatePlaceholderPassword = () => crypto.randomBytes(16).toString('hex');
const importAdmissionNumber = (schoolId, parentKey, child, index) => {
  const source = `${schoolId}|${parentKey}|${child.name}|${child.grade}|${index}`.toLowerCase();
  return `IMP-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12).toUpperCase()}`;
};

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
 * Uses phone number as username, generates password, sends via SMS
 */
exports.importParentsAndStudents = async (req, res) => {
  let transaction;
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

    transaction = await sequelize.transaction();

    const results = {
      parentsCreated: 0,
      parentsLinked: 0,
      studentsCreated: 0,
      skipped: [],
      errors: [],
      created: [], // returned so admin can see who was added
    };

    for (const parentData of parsedParents) {
      try {
        const { firstName, lastName } = splitName(parentData.name);
        const phone = normalizePhoneE164(parentData.phone);
        // Use phone as username; email is generated placeholder for DB constraint
        const email = generateEmail(parentData.name, schoolDomain);

        const identityConditions = [{ email }];
        if (phone) identityConditions.unshift({ phone });
        const matchingParents = await User.findAll({
          where: { role: 'parent', [Op.or]: identityConditions },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (matchingParents.length > 1) {
          throw new Error('Multiple parent accounts use this phone or email. Merge them before importing.');
        }
        let parent = matchingParents[0] || null;

        if (!parent) {
          parent = await User.create({
            schoolId,
            email,
            passwordHash: generatePlaceholderPassword(),
            firstName,
            lastName,
            role: 'parent',
            phone,
            mustSetPassword: true,
          }, { transaction });
          results.parentsCreated++;
          results.created.push({
            name: parentData.name,
            phone,
          });
        }

        const [, membershipCreated] = await ParentSchool.findOrCreate({
          where: { parentId: parent.id, schoolId },
          transaction,
        });
        if (membershipCreated && parent.schoolId !== schoolId) {
          results.parentsLinked++;
        } else if (!membershipCreated) {
          results.skipped.push(`Parent "${parentData.name}" already exists (phone: ${phone})`);
        }

        // Create students
        for (const [index, child] of parentData.children.entries()) {
          const childNames = splitName(child.name);
          const admissionNumber = importAdmissionNumber(schoolId, phone || email, child, index);
          const existingStudent = await Student.findOne({
            where: { schoolId, admissionNumber },
            transaction,
          });
          if (existingStudent) {
            results.skipped.push(`Student "${child.name}" already exists (admission: ${admissionNumber})`);
            continue;
          }
          await Student.create({
            schoolId,
            parentId: parent.id,
            admissionNumber,
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

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.status(201).json({
      message: `Import complete. ${results.parentsCreated} parents created, ${results.parentsLinked} existing parents linked, and ${results.studentsCreated} students created.`,
      ...results,
    });
  } catch (err) {
    if (transaction) await transaction.rollback();
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
