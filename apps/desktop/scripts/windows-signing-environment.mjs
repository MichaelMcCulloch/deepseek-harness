/** Credential scrubbing for every signing-related subprocess environment. */
const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD)/iu
const WINDOWS_SIGNING_ENVIRONMENT_PREFIX = 'DSH_DESKTOP_WINDOWS_'

/**
 * Remove inherited credentials before starting a signing-related subprocess.
 *
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @returns {NodeJS.ProcessEnv} Environment without credential-shaped names.
 */
export function scrubWindowsSigningEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)
      && !name.startsWith(WINDOWS_SIGNING_ENVIRONMENT_PREFIX)))
}
