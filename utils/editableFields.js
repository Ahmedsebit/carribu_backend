const editableFields = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('A request object is required.'), { status: 400 });
  }
  const unsupported = Object.keys(body).filter(field => !allowed.includes(field));
  if (unsupported.length) {
    throw Object.assign(new Error(`Fields cannot be edited: ${unsupported.join(', ')}.`), { status: 400 });
  }
  return Object.fromEntries(Object.entries(body).filter(([field]) => allowed.includes(field)));
};

module.exports = { editableFields };
