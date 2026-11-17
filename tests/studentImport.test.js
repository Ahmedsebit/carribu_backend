const request = require('supertest');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const app = require('./testApp');
const { setupTestDB } = require('./setup');
const { sequelize, School, User, Student, StudentImport, ParentSchool } = require('../models');
const migration = require('../migrations/0017-add-student-imports');

let data, token, otherToken, otherAdmin, otherSchool;
const header = 'Admission Number,First Name,Last Name,Grade,Parent Name,Parent Phone';
const auth = (req, bearer = token) => req.set('Authorization', `Bearer ${bearer}`);
const preview = (content, bearer = token) => auth(request(app).post('/api/import/preview'), bearer)
  .attach('file', Buffer.from(content), 'students.csv');
const confirm = (id, bearer = token) => auth(request(app).post('/api/import/parents-students'), bearer).send({ importId: id });
const sign = user => jwt.sign({ id: user.id, role: user.role, schoolId: user.schoolId }, process.env.JWT_SECRET || 'default-secret');

beforeAll(async () => {
  if (!/^carribu_imports_[a-z0-9_]+$/.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1') {
    throw new Error('Import integration tests require an explicitly isolated local carribu_imports_* database.');
  }
  data = await setupTestDB();
  await migration.down({ context: sequelize.getQueryInterface() });
  await migration.up({ context: sequelize.getQueryInterface() });
  token = sign(data.admin);
  otherSchool = await School.create({ name: 'Other Import School' });
  otherAdmin = await User.create({
    schoolId: otherSchool.id, role: 'school_admin', email: 'other-import@test.invalid',
    firstName: 'Other', lastName: 'Admin', passwordHash: 'test-password',
  });
  otherToken = sign(otherAdmin);
});
afterAll(async () => sequelize.close());
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await data.student1.update({ firstName: 'Child', lastName: 'One', grade: 'Grade 3', parentId: data.parent.id, isActive: true });
});

test('preview separates new, updated, error and unchanged rows without mutating student data', async () => {
  const before = await Student.count();
  const content = `${header}\nNEW-01,New,Student,Grade 1,,\ntest-001,Child,One,Grade 4,,\n,Missing,Admission,Grade 2,,\nTEST-002,Child,Two,Grade 3,,`;
  const result = await preview(content);
  expect(result.status).toBe(200);
  expect(result.body.counts).toMatchObject({ studentsToCreate: 1, studentsToUpdate: 1, errorRows: 1, unchangedRows: 1 });
  expect(result.body.rows[1].changes).toEqual({ grade: { from: 'Grade 3', to: 'Grade 4' } });
  expect(await Student.count()).toBe(before);
  await data.student1.reload();
  expect(data.student1.grade).toBe('Grade 3');
  expect(result.body.fileData).toBeUndefined();
  const original = await StudentImport.unscoped().findByPk(result.body.id);
  expect(original.fileData.toString()).toBe(content);

  const imported = await confirm(result.body.id);
  expect(imported.status).toBe(200);
  expect(imported.body.counts).toMatchObject({ studentsCreated: 1, studentsUpdated: 1, errorRows: 1, unchangedRows: 1 });
  expect(imported.body.status).toBe('completed');
  expect(imported.body.completedAt).toBeTruthy();
  await data.student1.reload();
  expect(data.student1.grade).toBe('Grade 4');
  expect(data.student1.parentId).toBe(data.parent.id);
  const retry = await confirm(result.body.id);
  expect(retry.body.counts).toEqual(imported.body.counts);
  expect(await Student.count()).toBe(before + 1);

  const history = await auth(request(app).get('/api/import/history'));
  expect(history.body.imports.find(item => item.id === result.body.id)).toMatchObject({
    filename: 'students.csv', uploaderName: 'Admin User', uploadedBy: data.admin.id, counts: imported.body.counts,
  });
  expect(history.body.imports[0].rows).toBeUndefined();
  expect(history.body.imports[0].fileData).toBeUndefined();
  const download = await auth(request(app).get(`/api/import/${result.body.id}/download`));
  expect(download.status).toBe(200);
  expect(download.text).toBe(content);
  expect(download.headers['content-disposition']).toContain('attachment;');
  const detail = await auth(request(app).get(`/api/import/${result.body.id}`));
  expect(detail.body.rows.find(row => row.action === 'error').rowNumber).toBe(4);
});

test('scopes matching, preview records, download, confirmation and history to the school', async () => {
  const plan = await preview('Admission Number,First Name,Last Name\nTEST-001,Other,Student', otherToken);
  expect(plan.body.counts.studentsToCreate).toBe(1);
  for (const suffix of ['', '/download']) {
    const response = await auth(request(app).get(`/api/import/${plan.body.id}${suffix}`));
    expect(response.status).toBe(404);
  }
  expect((await confirm(plan.body.id)).status).toBe(404);
  const history = await auth(request(app).get('/api/import/history'));
  expect(history.body.imports.some(item => item.id === plan.body.id)).toBe(false);
  expect((await confirm(plan.body.id, otherToken)).body.counts.studentsCreated).toBe(1);
  const original = await Student.findByPk(data.student1.id);
  expect(original.firstName).toBe('Child');
});

test('rechecks preview snapshots and records concurrent changes as errors without overwriting them', async () => {
  const plan = await preview('Admission Number,First Name,Last Name,Grade\nTEST-001,Child,One,Grade 5\nSTALE-NEW,New,Student,Grade 1');
  await data.student1.update({ grade: 'Grade 6' });
  await Student.create({ schoolId: data.school.id, admissionNumber: 'STALE-NEW', firstName: 'Concurrent', lastName: 'Student' });
  const result = await confirm(plan.body.id);
  expect(result.status).toBe(200);
  expect(result.body.counts).toMatchObject({ errorRows: 2, studentsCreated: 0, studentsUpdated: 0 });
  expect(result.body.rows[0].errors.join()).toMatch(/changed after preview/);
  expect((await data.student1.reload()).grade).toBe('Grade 6');
});

test('uses savepoints to roll back a failed row including its new parent while continuing valid rows', async () => {
  const content = `${header}\nFAIL-ROW,Fail,Student,Grade 1,New Parent,0712345678\nPASS-ROW,Pass,Student,Grade 1,,`;
  const plan = await preview(content);
  const create = Student.create.bind(Student);
  jest.spyOn(Student, 'create').mockImplementation((values, options) => create(
    values.admissionNumber === 'FAIL-ROW' ? { ...values, admissionNumber: 'TEST-002' } : values, options
  ));
  const result = await confirm(plan.body.id);
  expect(result.status).toBe(200);
  expect(result.body.counts).toMatchObject({ studentsCreated: 1, errorRows: 1 });
  expect(await User.findOne({ where: { phone: '+254712345678' } })).toBeNull();
  expect(await Student.findOne({ where: { admissionNumber: 'PASS-ROW' } })).not.toBeNull();
});

test('creates one parent for siblings, preserves existing profiles and links school memberships', async () => {
  const plan = await preview(`${header}\nSIB-1,First,Sibling,Grade 1,New Guardian,0723456789\nSIB-2,Second,Sibling,Grade 2,New Guardian,0723456789`);
  const result = await confirm(plan.body.id);
  expect(result.status).toBe(200);
  expect(result.body.counts).toMatchObject({ studentsCreated: 2, errorRows: 0 });
  const siblings = await Student.findAll({ where: { schoolId: data.school.id, admissionNumber: ['SIB-1', 'SIB-2'] } });
  expect(siblings[0].parentId).toBe(siblings[1].parentId);
  const guardian = await User.findByPk(siblings[0].parentId);
  expect(guardian.mustSetPassword).toBe(true);
  const repeated = await preview(`${header}\nSIB-1,First,Sibling,Grade 1,New Guardian,0723456789\nSIB-2,Second,Sibling,Grade 2,New Guardian,0723456789`);
  expect(repeated.body.counts).toMatchObject({ studentsToCreate: 0, studentsToUpdate: 0, unchangedRows: 2 });
  expect((await confirm(repeated.body.id)).body.counts.unchangedRows).toBe(2);

  const another = await preview(`${header}\nLINKED-1,Other,Child,Grade 3,Different Name,0723456789`, otherToken);
  expect(another.body.rows[0].parentAction).toMatch(/Link existing/);
  expect((await confirm(another.body.id, otherToken)).body.counts.studentsCreated).toBe(1);
  expect((await guardian.reload()).firstName).toBe('New');
  expect(await ParentSchool.findOne({ where: { parentId: guardian.id, schoolId: otherSchool.id, isActive: true } })).not.toBeNull();
});

test('omitted grades and blank parent data preserve links, while explicit blank grades clear them', async () => {
  await data.student1.update({ grade: 'Grade 6' });
  const plan = await preview('Admission Number,First Name,Last Name\nTEST-001,Renamed,Student');
  expect((await confirm(plan.body.id)).body.counts.studentsUpdated).toBe(1);
  expect(await data.student1.reload()).toMatchObject({ grade: 'Grade 6', parentId: data.parent.id, firstName: 'Renamed' });
  const clear = await preview(`${header}\nTEST-001,Renamed,Student,,,`);
  expect((await confirm(clear.body.id)).body.counts.studentsUpdated).toBe(1);
  expect(await data.student1.reload()).toMatchObject({ grade: null, parentId: data.parent.id });
});

test('does not allow import without preview, unauthorized roles, invalid files or missing columns', async () => {
  expect((await confirm(null)).status).toBe(400);
  expect((await preview('anything', sign(data.parent))).status).toBe(403);
  const columns = await preview('Parent Name,Phone Number,Child(ren),Grade/Class\nParent,0712345678,Child Student,Grade 1');
  expect(columns.status).toBe(400);
  expect(columns.body.stage).toBe('columns');
  const fake = await auth(request(app).post('/api/import/preview')).attach('file', Buffer.from('not excel'), 'students.xlsx');
  expect(fake.status).toBe(400);
  expect(fake.body.stage).toBe('file');
  const large = await auth(request(app).post('/api/import/preview')).attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'students.csv');
  expect(large.status).toBe(400);
});

test('two confirmations of the same preview commit once even when sent concurrently', async () => {
  const plan = await preview('Admission Number,First Name,Last Name\nCONCURRENT-1,Concurrent,Student');
  const results = await Promise.all([confirm(plan.body.id), confirm(plan.body.id)]);
  expect(results.map(response => response.status)).toEqual([200, 200]);
  expect(results[0].body.counts).toEqual(results[1].body.counts);
  expect(await Student.count({ where: { schoolId: data.school.id, admissionNumber: 'CONCURRENT-1' } })).toBe(1);
});

test('a different school administrator cannot confirm another uploader preview', async () => {
  const plan = await preview('Admission Number,First Name,Last Name\nOWNER-1,New,Student');
  const anotherAdmin = await User.create({
    schoolId: data.school.id, role: 'coordinator', email: 'coordinator-import@test.invalid',
    firstName: 'Other', lastName: 'Uploader', passwordHash: 'test-password',
  });
  expect((await confirm(plan.body.id, sign(anotherAdmin))).status).toBe(403);
});

test('unexpected failures roll back all writes and leave the saved preview safely retryable', async () => {
  const plan = await preview('Admission Number,First Name,Last Name\nSYSTEM-1,First,Student\nSYSTEM-2,Second,Student');
  const create = Student.create.bind(Student);
  const spy = jest.spyOn(Student, 'create').mockImplementation((values, options) => values.admissionNumber === 'SYSTEM-2'
    ? Promise.reject(new Error('simulated database outage')) : create(values, options));
  expect((await confirm(plan.body.id)).status).toBe(500);
  expect(await Student.count({ where: { admissionNumber: 'SYSTEM-1' } })).toBe(0);
  expect((await StudentImport.findByPk(plan.body.id)).status).toBe('previewed');
  spy.mockRestore();
  expect((await confirm(plan.body.id)).body.counts.studentsCreated).toBe(2);
});

test.each(['xlsx', 'xls'])('previews and confirms a real %s file while preserving the original bytes', async bookType => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Admission Number', 'First Name', 'Last Name'],
    [`EXCEL-${bookType}`, 'Excel', 'Student'],
  ]), 'Students');
  const buffer = XLSX.write(book, { type: 'buffer', bookType, compression: true });
  const plan = await auth(request(app).post('/api/import/preview')).attach('file', buffer, `students.${bookType}`);
  expect(plan.status).toBe(200);
  expect(plan.body.counts.studentsToCreate).toBe(1);
  const record = await StudentImport.unscoped().findByPk(plan.body.id);
  expect(record.fileData.equals(buffer)).toBe(true);
  expect((await confirm(plan.body.id)).body.counts.studentsCreated).toBe(1);
});

test('rejects compressed Excel files with excessive expanded content before parsing workbook cells', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Admission Number', 'First Name', 'Last Name'],
    ...Array.from({ length: 900 }, (_, index) => [`HUGE-${index}`, 'x'.repeat(32760), 'Student']),
  ]), 'Students');
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST: false });
  expect(buffer.length).toBeLessThan(5 * 1024 * 1024);
  const result = await auth(request(app).post('/api/import/preview')).attach('file', buffer, 'students.xlsx');
  expect(result.status).toBe(400);
  expect(result.body).toMatchObject({ stage: 'file', error: expect.stringContaining('25 MB') });
});
