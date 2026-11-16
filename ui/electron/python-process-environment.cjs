"use strict";

function pythonProcessEnvironment(baseEnvironment = {}) {
  const environment = { ...baseEnvironment };
  for (const name of [
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONUSERBASE",
    "PYTHONINSPECT",
  ]) {
    delete environment[name];
  }
  environment.PYTHONDONTWRITEBYTECODE = "1";
  environment.PYTHONNOUSERSITE = "1";
  return environment;
}

module.exports = { pythonProcessEnvironment };
