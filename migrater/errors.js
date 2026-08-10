/**
 * Failure kinds, because who is at fault decides what a failure costs.
 *
 * The API applies the policy (migrationController.failTask); this file just makes
 * the classification explicit at every throw site so nothing is misfiled — a
 * mislabelled infra blip would permanently fail good content, and a mislabelled
 * dead link would be retried forever.
 */

/** The source URL is not an MP4. Deterministic: refetching cannot change it. */
class NotMp4Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotMp4Error';
    this.kind = 'not-mp4';
  }
}

/** The source could not be fetched: 404/403, dead host, or it stalled repeatedly. */
class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
    this.kind = 'source';
  }
}

/** Our side broke — Wasabi, the API, this process, this disk. Costs the item nothing. */
class InfraError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InfraError';
    this.kind = 'infra';
  }
}

/** The task is no longer ours (released, requeued, or already migrated). Stop quietly. */
class RevokedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RevokedError';
    this.kind = 'revoked';
  }
}

module.exports = { NotMp4Error, SourceError, InfraError, RevokedError };
