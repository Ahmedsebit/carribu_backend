jest.mock('../models', () => ({}));
const XLSX = require('xlsx');
const { parseFile } = require('../services/studentImport');

const csv = text => ({ originalname: 'students.csv', buffer: Buffer.from(text) });
const header = 'Admission Number,First Name,Last Name,Grade,Parent Name,Parent Phone';
function workbook(rows, bookType = 'xlsx', edit) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (edit) edit(sheet, book);
  XLSX.utils.book_append_sheet(book, sheet, 'Students');
  return { originalname: `students.${bookType}`, buffer: XLSX.write(book, { type: 'buffer', bookType }) };
}

test('validates file contents before columns and rejects binary or renamed files', () => {
  for (const file of [
    { originalname: 'students.pdf', buffer: Buffer.from('not csv') },
    { originalname: 'students.xlsx', buffer: Buffer.from(`${header}\nA,A,B,1,,`) },
    csv('\u0000binary'), csv(''), { originalname: 'students.csv', buffer: Buffer.from([0xff, 0xfe, 0x00]) },
    { originalname: 'students.csv', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
  ]) {
    expect(() => parseFile(file)).toThrow();
    try { parseFile(file); } catch (error) { expect(error.stage).toBe('file'); }
  }
});

test.each([
  ['First Name,Last Name', /Admission Number/],
  ['Admission Number,First Name', /Last Name/],
  ['Admission Number,First Name,Last Name,Password', /Unsupported columns/],
  ['Admission Number,First Name,Last Name,Admission No', /Duplicate columns/],
  ['Admission Number,Student Name,First Name,Last Name', /not both/],
  ['Admission Number,First Name,Last Name,Parent Phone', /both Parent Name and Parent Phone/],
  ['Admission Number,First Name,Last Name,constructor', /Unsupported columns/],
])('rejects invalid headers before reading student rows: %s', (columns, message) => {
  expect(() => parseFile(csv(`${columns}\n1,A,B`))).toThrow(message);
});

test('keeps row numbers, normalizes admissions and phones, and reports all duplicate rows', () => {
  const { rows } = parseFile(csv(`\uFEFF${header}\nabc,Alice,One,Grade 1,Test Parent,0712345678\n\nABC,Bob,Two,Grade 2,,\n,Missing,Admission,Grade 3,,\nvalid,Carol,Three,Grade 2,,`));
  expect(rows.map(row => row.rowNumber)).toEqual([2, 4, 5, 6]);
  expect(rows[0].data).toMatchObject({ admissionNumber: 'ABC', parentPhone: '+254712345678' });
  expect(rows[0].errors.join()).toMatch(/more than once/);
  expect(rows[1].errors.join()).toMatch(/more than once/);
  expect(rows[2].errors.join()).toMatch(/Admission number is required/);
  expect(rows[3].errors).toEqual([]);
});

test.each(['xlsx', 'xls'])('reads actual %s workbooks and preserves formatted admission numbers', type => {
  const file = workbook([
    ['Admission Number', 'Student Name', 'Grade/Class', 'Parent Name', 'Phone Number'],
    [42, 'Alice Student', 'Grade 2', 'Test Parent', '0712345678'],
  ], type, sheet => { sheet.A2.z = '00000'; });
  const { rows } = parseFile(file);
  expect(rows[0]).toMatchObject({
    rowNumber: 2, errors: [],
    data: { admissionNumber: '00042', firstName: 'Alice', lastName: 'Student', grade: 'Grade 2', parentPhone: '+254712345678' },
  });
});

test('flags Excel formulas as row errors rather than importing cached results', () => {
  const file = workbook([
    ['Admission Number', 'First Name', 'Last Name'],
    ['A1', 'Alice', 'Student'],
  ], 'xlsx', sheet => { sheet.B2 = { t: 's', v: 'Alice', f: '"Alice"' }; });
  expect(parseFile(file).rows[0].errors).toContain('Formulas are not allowed. Replace them with values.');
});

test('does not silently ignore additional worksheets or rows beyond the limit', () => {
  const multiple = workbook([['Admission Number', 'First Name', 'Last Name'], ['A', 'A', 'B']], 'xlsx', (sheet, book) => {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['unreviewed data']]), 'Extra');
  });
  expect(() => parseFile(multiple)).toThrow(/exactly one/);
  const many = 'Admission Number,First Name,Last Name\n' + Array.from({ length: 5001 }, (_, i) => `${i},A,B`).join('\n');
  expect(() => parseFile(csv(many))).toThrow(/5000/);
});

test('reports invalid field lengths, unmatched parent data and extra row columns', () => {
  const { rows } = parseFile(csv(`${header}\nA,A,B,${'x'.repeat(21)},Parent,not a phone,extra\nB,A,B,Grade 1,,0712345678`));
  expect(rows[0].errors.join()).toMatch(/outside/);
  expect(rows[0].errors.join()).toMatch(/Grade/);
  expect(rows[0].errors.join()).toMatch(/phone/);
  expect(rows[1].errors.join()).toMatch(/parent name/);
});
