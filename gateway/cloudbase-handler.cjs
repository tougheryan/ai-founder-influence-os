// CommonJS entrypoint for Tencent Cloud Function consoles that expect the
// traditional `file.exported_handler` notation. The implementation stays in
// the ESM source module used by local tests and the Docker gateway.
let implementation;

async function loadImplementation() {
  implementation ||= import('./src/cloudbase-handler.mjs').then((module) => module.main_handler);
  return implementation;
}

async function main_handler(event, context) {
  return (await loadImplementation())(event, context);
}

exports.main_handler = main_handler;
exports.main = main_handler;

