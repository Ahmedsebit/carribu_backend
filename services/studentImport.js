const path = require('path');
const crypto = require('crypto');
const { TextDecoder, isDeepStrictEqual } = require('util');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const yauzl = require('yauzl');
const { Op } = require('sequelize');
const { Student, User, ParentSchool, School, StudentImport, sequelize } = require('../models');
const { normalizePhoneE164 } = require('../utils/phone');

const MAX_ROWS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EXCEL_BYTES = 25 * 1024 * 1024;
const FILE_TYPES = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};
const columns = {
  admissionnumber: 'admissionNumber', admissionno: 'admissionNumber',
  firstname: 'firstName', studentfirstname: 'firstName',
  lastname: 'lastName', studentlastname: 'lastName',
  studentname: 'studentName', childname: 'studentName', children: 'studentName',
  grade: 'grade', class: 'grade', gradeclass: 'grade',
  parentname: 'parentName',
  parentphone: 'parentPhone', phonenumber: 'parentPhone',
};
const fail = (message, stage = 'rows', status = 400) => Object.assign(new Error(message), { status, stage });
const cellText = value => String(value ?? '').trim();
const key = value => cellText(value).toUpperCase();
const snapshot = student => student ? {
  id: student.id, admissionNumber: student.admissionNumber, firstName: student.firstName,
  lastName: student.lastName, grade: student.grade, parentId: student.parentId, isActive: student.isActive,
} : null;

async function validateExcelArchive(file) {
  if (!file?.buffer || file.buffer.length > MAX_BYTES || !/\.xlsx$/i.test(file.originalname)) return;
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(file.buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      const invalid = () => reject(fail('Excel workbook is invalid or exceeds the 25 MB expanded-size limit.', 'file'));
      if (error) return invalid();
      let total = 0;
      let stream;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        stream?.destroy();
        zip.close();
        invalid();
      };
      zip.on('error', stop);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        if (zip.entryCount > 1000 || total + entry.uncompressedSize > MAX_EXCEL_BYTES) return stop();
        zip.openReadStream(entry, (readError, input) => {
          if (readError) return stop();
          stream = input;
          input.on('error', stop);
          input.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_EXCEL_BYTES) stop();
          });
          input.on('end', () => { if (!stopped) zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function readFile(file) {
  if (!file?.buffer) throw fail('Select a CSV or Excel file.', 'file');
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (!FILE_TYPES[extension]) throw fail('Only .csv, .xls and .xlsx files are supported.', 'file');
  if (!file.buffer.length || file.buffer.length > MAX_BYTES) {
    throw fail('The file must be non-empty and no larger than 5 MB.', 'file');
  }
  try {
    if (extension === '.csv') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) throw new Error('Binary content');
      const records = parse(text, {
        bom: true, trim: true, relax_column_count: true, max_record_size: 65536,
        to: MAX_ROWS + 2,
      });
      if (records.length > MAX_ROWS + 1) throw fail(`Use at most ${MAX_ROWS} data rows per file.`, 'file');
      return { records, formulas: new Set(), extension };
    }
    const signature = file.buffer.subarray(0, 8).toString('hex');
    if ((extension === '.xlsx' && !signature.startsWith('504b0304'))
      || (extension === '.xls' && signature !== 'd0cf11e0a1b11ae1')) {
      throw fail('The file contents do not match its Excel extension.', 'file');
    }
    const workbook = XLSX.read(file.buffer, {
      type: 'buffer', sheetRows: MAX_ROWS + 2, cellFormula: true, cellHTML: false,
    });
    const sheets = workbook.SheetNames.map(name => workbook.Sheets[name]).filter(sheet => sheet['!ref']);
    if (sheets.length !== 1) throw fail('Excel files must contain exactly one non-empty worksheet.', 'file');
    const sheet = sheets[0];
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
    if (range.e.r > MAX_ROWS || range.e.c > 49) {
      throw fail(`Use at most ${MAX_ROWS} data rows and 50 columns.`, 'file');
    }
    const formulas = new Set();
    for (const address of Object.keys(sheet)) {
      if (!address.startsWith('!') && (sheet[address].f || sheet[address].F)) {
        formulas.add(XLSX.utils.decode_cell(address).r);
      }
    }
    return {
      records: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', range: 0 }),
      formulas, extension,
    };
  } catch (error) {
    if (error.stage) throw error;
    throw fail('The file could not be read. Use a valid UTF-8 comma-separated CSV or an unencrypted Excel workbook.', 'file');
  }
}

function parseFile(file) {
  const { records, formulas, extension } = readFile(file);
  if (!records.length) throw fail('The file is empty.', 'file');
  const headers = records[0].map(cellText);
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (!headers.length || formulas.has(0)) throw fail('The first row must contain column headers, not formulas.', 'columns');
  const mapped = headers.map(header => {
    const name = header.toLowerCase().replace(/[^a-z0-9]/g, '');
    return Object.hasOwn(columns, name) ? columns[name] : undefined;
  });
  const unsupported = headers.filter((header, index) => !mapped[index]);
  if (unsupported.length) throw fail(`Unsupported columns: ${unsupported.join(', ')}.`, 'columns');
  if (new Set(mapped).size !== mapped.length) throw fail('Duplicate columns are not allowed.', 'columns');
  if (!mapped.includes('admissionNumber')) throw fail('Admission Number column is required.', 'columns');
  const hasFullName = mapped.includes('studentName');
  const hasParts = mapped.includes('firstName') && mapped.includes('lastName');
  if (!hasFullName && !hasParts) throw fail('Include First Name and Last Name, or Student Name.', 'columns');
  if (hasFullName && (mapped.includes('firstName') || mapped.includes('lastName'))) {
    throw fail('Use either Student Name or First Name and Last Name, not both.', 'columns');
  }
  if (mapped.includes('parentName') !== mapped.includes('parentPhone')) {
    throw fail('Include both Parent Name and Parent Phone columns, or neither.', 'columns');
  }
  const rows = [];
  for (let index = 1; index < records.length; index++) {
    const cells = records[index].map(cellText);
    if (cells.every(value => !value) && !formulas.has(index)) continue;
    const data = Object.fromEntries(mapped.map((field, column) => [field, cells[column] || '']));
    const errors = [];
    if (cells.slice(headers.length).some(Boolean)) errors.push('This row has data outside the declared columns.');
    if (formulas.has(index)) errors.push('Formulas are not allowed. Replace them with values.');
    data.admissionNumber = key(data.admissionNumber);
    if (hasFullName) {
      const names = cellText(data.studentName).split(/\s+/);
      data.firstName = names[0] || '';
      data.lastName = names.slice(1).join(' ');
      delete data.studentName;
    }
    for (const [field, label, limit] of [
      ['admissionNumber', 'Admission number', 50], ['firstName', 'First name', 100], ['lastName', 'Last name', 100],
    ]) {
      if (!data[field]) errors.push(`${label} is required.`);
      else if (data[field].length > limit) errors.push(`${label} must not exceed ${limit} characters.`);
    }
    if (data.grade?.length > 20) errors.push('Grade must not exceed 20 characters.');
    if (data.parentName || data.parentPhone) {
      const parts = cellText(data.parentName).split(/\s+/);
      if (!data.parentName || parts[0].length > 100 || parts.slice(1).join(' ').length > 100) {
        errors.push('A parent name is required and each name part must not exceed 100 characters.');
      }
      const phone = normalizePhoneE164(data.parentPhone);
      if (!/^[+\d\s().-]+$/.test(data.parentPhone || '') || !/^\+[1-9]\d{7,14}$/.test(phone || '')) {
        errors.push('A valid parent phone number is required.');
      } else {
        data.parentPhone = phone;
      }
    }
    rows.push({ rowNumber: index + 1, data, errors, action: 'create', existing: null, changes: {} });
  }
  if (!rows.length) throw fail('The file has headers but no student rows.');
  const admissions = new Map();
  for (const row of rows) {
    const admission = row.data.admissionNumber;
    if (!admission) continue;
    if (!admissions.has(admission)) admissions.set(admission, []);
    admissions.get(admission).push(row);
  }
  for (const duplicates of admissions.values()) {
    if (duplicates.length > 1) {
      for (const row of duplicates) row.errors.push('Admission number occurs more than once in this file.');
    }
  }
  return { rows, extension };
}

function countRows(rows) {
  const count = action => rows.filter(row => row.action === action).length;
  return {
    totalRows: rows.length, studentsToCreate: count('create'), studentsToUpdate: count('update'),
    studentsCreated: count('created'), studentsUpdated: count('updated'),
    unchangedRows: count('unchanged'), errorRows: count('error'),
  };
}

function studentValues(row, parentId) {
  const values = {
    admissionNumber: row.data.admissionNumber,
    firstName: row.data.firstName, lastName: row.data.lastName,
  };
  if (Object.hasOwn(row.data, 'grade')) values.grade = row.data.grade || null;
  if (parentId !== undefined) values.parentId = parentId;
  return values;
}

async function findParent(phone, transaction) {
  if (!phone) return null;
  const parents = await User.findAll({ where: { role: 'parent', phone }, transaction });
  if (parents.length > 1) throw fail('Multiple parent accounts use this phone. Resolve them before importing.');
  if (parents[0] && !parents[0].isActive) throw fail('This parent account is inactive. Resolve it before importing.');
  return parents[0] || null;
}

async function planImport(file, schoolId) {
  await validateExcelArchive(file);
  const { rows, extension } = parseFile(file);
  const students = await Student.findAll({ where: { schoolId } });
  const byAdmission = new Map();
  for (const student of students) {
    const admission = key(student.admissionNumber);
    if (!byAdmission.has(admission)) byAdmission.set(admission, []);
    byAdmission.get(admission).push(student);
  }
  const parents = new Map();
  for (const row of rows) {
    const matches = byAdmission.get(row.data.admissionNumber) || [];
    const student = matches[0];
    row.existing = snapshot(student);
    if (matches.length > 1) row.errors.push('Multiple students match this admission number. Resolve them first.');
    if (student && !student.isActive) row.errors.push('This student is inactive. Reactivate it separately before updating.');
    if (row.data.parentPhone && !row.errors.length) {
      if (!parents.has(row.data.parentPhone)) {
        try {
          parents.set(row.data.parentPhone, { parent: await findParent(row.data.parentPhone) });
        } catch (error) {
          if (!error.status) throw error;
          parents.set(row.data.parentPhone, { error: error.message });
        }
      }
      const match = parents.get(row.data.parentPhone);
      if (match.error) row.errors.push(match.error);
      else {
        row.parentId = match.parent?.id || null;
        if (match.parent) {
          const membership = await ParentSchool.findOne({ where: { parentId: match.parent.id, schoolId } });
          row.parentAction = membership?.isActive ? 'Existing parent account' : membership
            ? 'Restore parent access to this school' : 'Link existing parent account to this school';
        } else {
          const conflict = await User.findOne({ where: { schoolId, phone: row.data.parentPhone } });
          if (conflict) row.errors.push('This phone is used by a non-parent account in this school.');
          row.parentAction = 'Create parent account';
        }
      }
    }
    if (student) {
      const values = studentValues(row, row.data.parentPhone ? row.parentId : undefined);
      for (const [field, value] of Object.entries(values)) {
        if (value !== student[field] || (field === 'parentId' && !row.parentId && row.data.parentPhone)) {
          row.changes[field] = { from: student[field] ?? null, to: value };
        }
      }
      row.action = Object.keys(row.changes).length ? 'update' : 'unchanged';
    }
    if (row.errors.length) row.action = 'error';
  }
  return { rows, counts: countRows(rows), contentType: FILE_TYPES[extension] };
}

async function saveRow(row, schoolId, transaction) {
  if (row.action === 'error') return row;
  const matches = await Student.findAll({
    where: { schoolId, admissionNumber: { [Op.iLike]: row.data.admissionNumber.replace(/[\\%_]/g, '\\$&') } },
    transaction, lock: transaction.LOCK.UPDATE,
  });
  const student = matches[0] || null;
  if (matches.length > 1 || !isDeepStrictEqual(snapshot(student), row.existing)) {
    throw fail('Student changed after preview. Upload the file again to review this row.');
  }
  let parentId;
  if (row.data.parentPhone) {
    // Serialize account resolution across schools without storing a phone in a lock key.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:identity))', {
      replacements: { identity: `student-import:${row.data.parentPhone}` }, transaction,
    });
    let parent = await findParent(row.data.parentPhone, transaction);
    if ((parent?.id || null) !== row.parentId) throw fail('Parent account changed after preview. Preview this file again.');
    if (!parent) {
      const parts = row.data.parentName.split(/\s+/);
      const emailId = crypto.createHash('sha256').update(row.data.parentPhone).digest('hex').slice(0, 24);
      parent = await User.create({
        schoolId, firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0],
        phone: row.data.parentPhone, email: `import.${emailId}@school${schoolId}.carribu.local`,
        role: 'parent', passwordHash: crypto.randomBytes(24).toString('hex'), mustSetPassword: true,
      }, { transaction });
    }
    const [membership] = await ParentSchool.findOrCreate({
      where: { parentId: parent.id, schoolId }, defaults: { isActive: true }, transaction,
    });
    if (!membership.isActive) await membership.update({ isActive: true }, { transaction });
    parentId = parent.id;
  }
  const values = studentValues(row, parentId);
  if (!student) {
    const created = await Student.create({ ...values, schoolId }, { transaction });
    return { ...row, parentId, studentId: created.id, action: 'created' };
  }
  if (row.action === 'unchanged') return { ...row, parentId };
  await student.update(values, { transaction });
  return { ...row, parentId, studentId: student.id, action: 'updated' };
}

async function confirmImport(importId, user) {
  return sequelize.transaction(async transaction => {
    // A school lock orders concurrent imports; the record lock makes retries idempotent.
    await School.findByPk(user.schoolId, { transaction, lock: transaction.LOCK.UPDATE });
    const record = await StudentImport.findOne({
      where: { id: importId, schoolId: user.schoolId }, transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!record) throw fail('Upload record not found.', 'import', 404);
    if (record.status === 'completed') return record;
    if (record.uploadedBy !== user.id) throw fail('Only the uploader can confirm this preview.', 'import', 403);
    const rows = [];
    const resolvedParents = new Map();
    for (const planned of record.rows) {
      let row = planned;
      // Repeated rows for a newly created parent refer to the account created above.
      if (row.parentId === null && resolvedParents.has(row.data.parentPhone)) {
        row = { ...row, parentId: resolvedParents.get(row.data.parentPhone) };
      }
      // Use a distinct name: findOrCreate hooks create their own Sequelize savepoints.
      await sequelize.query('SAVEPOINT student_import_row', { transaction });
      try {
        const result = await saveRow(row, user.schoolId, transaction);
        await sequelize.query('RELEASE SAVEPOINT student_import_row', { transaction });
        rows.push(result);
        if (result.parentId) resolvedParents.set(row.data.parentPhone, result.parentId);
      } catch (error) {
        await sequelize.query('ROLLBACK TO SAVEPOINT student_import_row', { transaction });
        await sequelize.query('RELEASE SAVEPOINT student_import_row', { transaction });
        if (!error.status && !['SequelizeUniqueConstraintError', 'SequelizeValidationError'].includes(error.name)) throw error;
        rows.push({
          ...row, action: 'error',
          errors: [...row.errors, error.status ? error.message : 'This row conflicts with existing data. Correct it and preview again.'],
        });
      }
    }
    await record.update({ rows, counts: countRows(rows), status: 'completed', completedAt: new Date() }, { transaction });
    return record;
  });
}

module.exports = { MAX_BYTES, parseFile, planImport, countRows, confirmImport, fail };
