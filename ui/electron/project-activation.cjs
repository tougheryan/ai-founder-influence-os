async function restoreAndActivateProject({
  currentProjectDir,
  nextProjectDir,
  restore,
  selectProject,
  restart,
  restartAfterRollback = restart,
}) {
  // `restore` must perform the complete schema/path/symlink/checksum copy into
  // a new directory. No active-project state is changed before it resolves.
  const restored = await restore();
  try {
    await selectProject(nextProjectDir);
    await restart();
  } catch (error) {
    await selectProject(currentProjectDir).catch(() => {});
    await restartAfterRollback().catch(() => {});
    throw error;
  }
  return restored;
}

module.exports = { restoreAndActivateProject };
