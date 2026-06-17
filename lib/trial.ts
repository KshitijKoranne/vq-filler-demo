export type TrialStatus = {
  active: boolean;
  clientName: string;
  expiresAt: string | null;
  reason?: string;
};

export class TrialInactiveError extends Error {
  status: TrialStatus;

  constructor(status: TrialStatus) {
    super(status.reason || 'This trial is not active.');
    this.name = 'TrialInactiveError';
    this.status = status;
  }
}

function clientName() {
  return process.env.TRIAL_CLIENT_NAME || 'Demo client';
}

export function getTrialStatus(now = new Date()): TrialStatus {
  const rawExpiry = process.env.TRIAL_EXPIRES_AT;

  if (!rawExpiry) {
    if (process.env.NODE_ENV !== 'production') {
      return {
        active: true,
        clientName: clientName(),
        expiresAt: null,
        reason: 'Trial expiry is not configured in local development.',
      };
    }

    return {
      active: false,
      clientName: clientName(),
      expiresAt: null,
      reason: 'Trial expiry is not configured for this deployment.',
    };
  }

  const expiresAt = new Date(rawExpiry);
  if (Number.isNaN(expiresAt.getTime())) {
    return {
      active: false,
      clientName: clientName(),
      expiresAt: rawExpiry,
      reason: 'Trial expiry is invalid.',
    };
  }

  if (now.getTime() > expiresAt.getTime()) {
    return {
      active: false,
      clientName: clientName(),
      expiresAt: expiresAt.toISOString(),
      reason: 'This trial has expired.',
    };
  }

  return {
    active: true,
    clientName: clientName(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function requireActiveTrial() {
  const status = getTrialStatus();
  if (!status.active) throw new TrialInactiveError(status);
  return status;
}

export function trialInactiveResponse(status = getTrialStatus()) {
  return Response.json({
    error: status.reason || 'This trial is not active.',
    trial: status,
  }, { status: 403 });
}
