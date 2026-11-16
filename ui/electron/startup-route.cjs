function modelIsConfigured(payload) {
  const config = payload && typeof payload === "object" ? payload.config : null;
  if (!config || typeof config !== "object") return false;
  if (config.connectionMode === "hosted") return config.gatewayConnected === true;
  return config.hasSavedKey === true || config.hasEnvKey === true;
}

function hostedMode(payload) {
  const config = payload && typeof payload === "object" ? payload.config : null;
  return Boolean(config && typeof config === "object" && config.connectionMode === "hosted");
}

function licenseRequired(payload) {
  const config = payload && typeof payload === "object" ? payload.config : null;
  return Boolean(config && typeof config === "object" && config.licenseRequired === true);
}

function tikOmniIsConfigured(payload) {
  const setup = payload && typeof payload === "object" ? payload.setup : null;
  return Boolean(setup && typeof setup === "object" && setup.status === "ready_to_test");
}

function desktopStartupRoute(configPayload, tikOmniPayload, hostedStatusPayload) {
  const blockers = [];
  if (licenseRequired(configPayload) && hostedStatusPayload?.connected !== true) {
    return {
      path: "/settings?firstRun=1",
      blockers: ["device_activation_required"],
    };
  }
  if (!modelIsConfigured(configPayload)) blockers.push("model_configuration_required");
  // Invite-only builds keep owner-operated research credentials server-side.
  // The old local TikOmni checklist must not ask a friend to provide a token.
  if (!hostedMode(configPayload) && !tikOmniIsConfigured(tikOmniPayload)) blockers.push("tikomni_configuration_required");

  return {
    // Direct local builds open the home page. Paid hosted builds stay on the
    // activation screen until this device has a valid licensed session.
    path: "/",
    blockers,
  };
}

module.exports = {
  desktopStartupRoute,
  modelIsConfigured,
  hostedMode,
  licenseRequired,
  tikOmniIsConfigured,
};
