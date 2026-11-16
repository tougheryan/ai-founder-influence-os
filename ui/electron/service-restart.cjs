async function restartDesktopService({
  stop,
  start,
  beforeStart = () => {},
  onFailure = () => {},
  afterReady = null,
  scheduleAfterReady = (callback) => callback(),
  requireReady = false,
}) {
  try {
    await stop();
    await beforeStart();
    const result = await start();
    if (requireReady && result?.ready !== true) {
      throw new Error("Local service restart did not reach authenticated health readiness.");
    }
    if (result?.ready === true && typeof afterReady === "function") {
      scheduleAfterReady(() => afterReady(result));
    }
    return result || { ready: false };
  } catch (error) {
    onFailure(error);
    if (requireReady) throw error;
    return { ready: false, error: true };
  }
}

async function updateCredentialWithCheckedRestart({
  readCurrent,
  apply,
  restore,
  restart,
}) {
  const previous = readCurrent();
  const result = apply();
  try {
    await restart();
    return result;
  } catch (error) {
    restore(previous);
    try {
      await restart();
    } catch (rollbackError) {
      const failure = new Error("Credential update failed and the previous local service could not be restored.");
      failure.cause = rollbackError;
      throw failure;
    }
    throw error;
  }
}

async function runWithQuiescedService({ stop, waitStopped, operation, start }) {
  await stop();
  if (typeof waitStopped === "function" && !(await waitStopped())) {
    throw new Error("Local service did not stop cleanly; project snapshot was not created.");
  }

  let operationResult;
  let operationError;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }

  let startResult;
  try {
    startResult = await start();
    if (startResult?.ready !== true) {
      throw new Error("Local service did not become healthy after the project snapshot operation.");
    }
  } catch (startError) {
    const failure = new Error("Project snapshot operation stopped the local service, but a healthy service could not be restored.");
    failure.cause = startError;
    throw failure;
  }

  if (operationError) throw operationError;
  return { operationResult, startResult };
}

module.exports = { restartDesktopService, runWithQuiescedService, updateCredentialWithCheckedRestart };
