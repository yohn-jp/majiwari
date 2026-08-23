import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_PROFILE_PATH,
  ProfileValidationError,
  WORKER_DIR,
  buildWranglerConfig,
  readDeploymentProfile,
  resolveProfilePath,
  safeProfileSummary
} from "./profile.mjs";

const GENERATED_CONFIG_PATH = path.join(WORKER_DIR, "wrangler.profile.generated.jsonc");

function parseArgs(argv) {
  let profilePath = DEFAULT_PROFILE_PATH;
  const wranglerArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (!value) throw new Error("--profile requires a path");
      profilePath = resolveProfilePath(value);
      index += 1;
    } else {
      wranglerArgs.push(argument);
    }
  }
  return { profilePath, wranglerArgs };
}

try {
  const { profilePath, wranglerArgs } = parseArgs(process.argv.slice(2));
  const profile = await readDeploymentProfile(profilePath);
  const baseConfig = JSON.parse(await readFile(path.join(WORKER_DIR, "wrangler.jsonc"), "utf8"));
  const generatedConfig = buildWranglerConfig(baseConfig, profile);
  await writeFile(GENERATED_CONFIG_PATH, `${JSON.stringify(generatedConfig, null, 2)}\n`, "utf8");

  process.stdout.write(`Deployment preflight passed\n${safeProfileSummary(profile)}\n`);
  const result = spawnSync("wrangler", ["deploy", "--config", GENERATED_CONFIG_PATH, ...wranglerArgs], {
    cwd: WORKER_DIR,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  if (error instanceof ProfileValidationError || error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("deployment failed\n");
  }
  process.exitCode = 1;
}
