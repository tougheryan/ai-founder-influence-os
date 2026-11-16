function createServiceLifecycleCoordinator(enqueue) {
  if (typeof enqueue !== "function") {
    throw new TypeError("Service lifecycle coordinator requires a queue function.");
  }
  let generation = 0;

  return {
    run(task) {
      if (typeof task !== "function") throw new TypeError("Service lifecycle task must be a function.");
      const ticket = ++generation;
      return enqueue(() => task({
        ticket,
        isCurrent: () => ticket === generation,
      }));
    },
    supersede() {
      generation += 1;
      return generation;
    },
    generation() {
      return generation;
    },
  };
}

module.exports = { createServiceLifecycleCoordinator };
