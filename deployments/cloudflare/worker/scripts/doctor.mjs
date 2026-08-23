import {
  DEFAULT_PROFILE_PATH,
  ProfileValidationError,
  readDeploymentProfile,
  resolveProfilePath,
  safeProfileSummary
} from "./profile.mjs";

function usage() {
  process.stderr.write("Usage: npm run preflight -- [--profile <path>]\n");
}

function parseArgs(argv) {
  let profilePath = DEFAULT_PROFILE_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (!value) throw new Error("--profile requires a path");
      profilePath = resolveProfilePath(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return profilePath;
}

try {
  const profilePath = parseArgs(process.argv.slice(2));
  const profile = await readDeploymentProfile(profilePath);
  process.stdout.write(`Deployment preflight passed\n${safeProfileSummary(profile)}\n`);
} catch (error) {
  if (error instanceof ProfileValidationError || error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("deployment preflight failed\n");
  }
  usage();
  process.exitCode = 1;
}
