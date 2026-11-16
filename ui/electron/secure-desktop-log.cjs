const fs = require("fs");
const path = require("path");

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

function requireNoFollowFlag() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("Secure desktop logging is unavailable: O_NOFOLLOW is not supported.");
  }
  return fs.constants.O_NOFOLLOW;
}

function ensureSecureLogDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: LOG_DIRECTORY_MODE });

  if (!Number.isInteger(fs.constants.O_DIRECTORY)) {
    throw new Error("Secure desktop logging is unavailable: O_DIRECTORY is not supported.");
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | requireNoFollowFlag();
  const descriptor = fs.openSync(directory, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory()) {
      throw new Error("Desktop log directory must be a real directory, not a symbolic link.");
    }
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      throw new Error("Desktop log directory must be owned by the current user.");
    }
    fs.fchmodSync(descriptor, LOG_DIRECTORY_MODE);

    const secured = fs.fstatSync(descriptor);
    const target = fs.lstatSync(directory);
    if (!secured.isDirectory() || (secured.mode & 0o777) !== LOG_DIRECTORY_MODE
      || target.isSymbolicLink() || !target.isDirectory()
      || target.dev !== secured.dev || target.ino !== secured.ino) {
      throw new Error("Desktop log directory changed during security validation.");
    }
    return {
      directory,
      dev: secured.dev,
      ino: secured.ino,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function revalidateSecureLogDirectory(snapshot) {
  const current = fs.lstatSync(snapshot.directory);
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== snapshot.dev || current.ino !== snapshot.ino) {
    throw new Error("Desktop log directory changed before the log file was secured.");
  }
}

function validateOpenedLogFile(filePath, descriptor) {
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile()) {
    throw new Error("Desktop log target must be a regular file.");
  }
  if (opened.nlink !== 1) {
    throw new Error("Desktop log target must not be a hard-linked file.");
  }
  if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
    throw new Error("Desktop log target must be owned by the current user.");
  }

  const target = fs.lstatSync(filePath);
  if (target.isSymbolicLink() || !target.isFile()
    || target.dev !== opened.dev || target.ino !== opened.ino) {
    throw new Error("Desktop log target changed during security validation.");
  }

  fs.fchmodSync(descriptor, LOG_FILE_MODE);
  const secured = fs.fstatSync(descriptor);
  if (!secured.isFile() || secured.dev !== opened.dev || secured.ino !== opened.ino
    || (secured.mode & 0o777) !== LOG_FILE_MODE) {
    throw new Error("Desktop log permissions could not be secured.");
  }
}

function openSecureDesktopLogStream(filePath) {
  const directory = ensureSecureLogDirectory(filePath);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_APPEND
    | fs.constants.O_CREAT
    | requireNoFollowFlag();
  let descriptor = fs.openSync(filePath, flags, LOG_FILE_MODE);
  try {
    revalidateSecureLogDirectory(directory);
    validateOpenedLogFile(filePath, descriptor);
    const stream = fs.createWriteStream(filePath, {
      fd: descriptor,
      autoClose: true,
      emitClose: true,
    });
    descriptor = null;
    return stream;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

module.exports = {
  LOG_DIRECTORY_MODE,
  LOG_FILE_MODE,
  ensureSecureLogDirectory,
  openSecureDesktopLogStream,
  revalidateSecureLogDirectory,
  validateOpenedLogFile,
};
