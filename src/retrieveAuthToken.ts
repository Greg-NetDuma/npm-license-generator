// Code inspired from https://github.com/vanioinformatika/node-npmrc-auth-token-retriever

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function findAuthToken(
  content: string,
  registry = "registry.npmjs.org"
): string | null {
  const lines = content.split("\n").map((line) => line.trim());

  let normalizedRegistry = registry;
  if (normalizedRegistry.endsWith("/"))
    normalizedRegistry = normalizedRegistry.substring(
      0,
      normalizedRegistry.length - 1
    );
  normalizedRegistry = normalizedRegistry.replace(/\//g, "\\/");

  const authTokenLine = lines.find((line) =>
    new RegExp(`^//${normalizedRegistry}/:_authToken=`).test(line)
  );

  if (!authTokenLine) {
    return null;
  }

  let token: string | null = authTokenLine.substr(
    `//${registry}/:_authToken=`.length
  );

  if (token?.startsWith("$")) {
    token = token.replace(/$\{\}/g, "");
    token = process.env[token] ?? null;
  }

  return token;
}

export function retrieveAuthToken(
  registry = "registry.npmjs.org",
  npmrcPath?: string
): string | null {
  const paths: (string | undefined)[] = [
    npmrcPath,
    ".npmrc",
    path.join(os.homedir(), ".npmrc").toString(),
  ];

  let content = "";

  for (const path of paths) {
    if (path == null || !fs.existsSync(path)) {
      continue;
    }

    content += `\n${fs.readFileSync(path, { encoding: "utf8" })}`;
  }

  return findAuthToken(content, registry);
}
