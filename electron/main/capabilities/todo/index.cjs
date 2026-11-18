const manifests = require('./manifest.cjs');
const { createStudioTodoExtension } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-todo', createStudioTodoExtension(durable)],
  ]);
}

module.exports = {
  ...require('./extension.cjs'),
  create,
  manifests,
};
